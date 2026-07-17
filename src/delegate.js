import { readFileSync, statSync } from "node:fs";
import { AcpClient } from "./acp-client.js";
import { SessionSupervisor } from "./session-supervisor.js";
import { normalizeAgentReportedFiles } from "./agent-reported-files.js";

export const DEFAULT_MODEL = "composer-2.5";

function resolveSpec(spec) {
  if (typeof spec !== "string") return spec;
  const looksLikePath = !spec.includes("\n")
    && (spec.includes("/") || spec.includes("\\") || spec.endsWith(".md") || spec.endsWith(".txt"));
  if (!looksLikePath) return spec;
  try {
    if (statSync(spec).isFile()) return readFileSync(spec, "utf8");
  } catch {}
  return spec;
}

async function openSession(client, resumeSessionId, workspace) {
  if (!resumeSessionId) return client.newSession(workspace);
  try {
    await client.loadSession(resumeSessionId, workspace);
    return { sessionId: resumeSessionId }; // load does not echo sessionId
  } catch {
    // stale or unknown session — start fresh
  }
  return client.newSession(workspace);
}

// Composer bare ids (e.g. composer-2.5) expose standard vs fast via set_config_option.
// Other models use separate ids (e.g. gpt-5-fast) — see cursor-agent --list-models.
function composerFastToggleApplies(model) {
  return /^composer-\d+(?:\.\d+)?$/i.test(model);
}

export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model = DEFAULT_MODEL, fast = false, clientFactory, onElicit,
  idleMs = 90000, hardCapMs, timeoutMs,
  onSessionReady, onProgress, progressThrottleMs = 2000,
  signal,
} = {}) {
  if (signal?.aborted) {
    const err = new Error("delegation aborted by MCP host");
    err.reason = "aborted";
    throw err;
  }
  const capMs = hardCapMs ?? timeoutMs ?? 3600000;
  const MAX_OUTPUT = 10 * 1024 * 1024;
  const TRUNCATION_MARKER = "\n\n[output truncated at 10MB]";
  const questionsAsked = [];
  const recordQuestions = (q) => {
    if (q.kind !== "ask_question") return;
    for (const question of q.questions || []) {
      if (typeof question?.prompt === "string" && question.prompt) questionsAsked.push(question.prompt);
    }
  };
  const wrappedElicit = onElicit
    ? async (q) => { recordQuestions(q); return onElicit(q); }
    : async (q) => { recordQuestions(q); return null; };

  let planEntries = [];
  let planOverview;
  let planDetail;
  const recordCreatePlan = (body) => {
    if (body?.overview !== undefined) planOverview = body.overview;
    if (body?.plan !== undefined) planDetail = body.plan;
  };

  // ACP requires plan entry content to be a string and bounds priority/status to
  // known values. Frames that violate that must not fail the MCP call after the
  // work is done — drop the bad data and report it as a protocol diagnostic.
  const PLAN_PRIORITIES = ["high", "medium", "low"];
  const PLAN_STATUSES = ["pending", "in_progress", "completed"];
  const sanitizePlan = (warnings) => {
    const entries = [];
    planEntries.forEach((raw, i) => {
      if (typeof raw?.content !== "string") {
        warnings.push(`plan entry ${i} dropped: ACP requires string content, got ${raw === null ? "null" : typeof raw?.content}`);
        return;
      }
      const entry = { ...raw };
      if (entry.priority !== undefined && !PLAN_PRIORITIES.includes(entry.priority)) {
        warnings.push(`plan entry ${i}: non-ACP priority ${JSON.stringify(entry.priority)} removed`);
        delete entry.priority;
      }
      if (entry.status !== undefined && !PLAN_STATUSES.includes(entry.status)) {
        warnings.push(`plan entry ${i}: non-ACP status ${JSON.stringify(entry.status)} removed`);
        delete entry.status;
      }
      entries.push(entry);
    });
    const plan = { entries };
    if (planOverview !== undefined) {
      if (typeof planOverview === "string") plan.overview = planOverview;
      else warnings.push("plan overview dropped: expected string");
    }
    if (planDetail !== undefined) {
      if (typeof planDetail === "string") plan.detail = planDetail;
      else warnings.push("plan detail dropped: expected string");
    }
    return plan;
  };

  const make = clientFactory || ((opts) => new AcpClient(opts));
  const client = make({ onElicit: wrappedElicit, mode, onCreatePlan: recordCreatePlan });
  const supervisor = new SessionSupervisor(client, { idleMs, hardCapMs: capMs });
  const onAbort = () => supervisor.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const resultChunks = [];
  let resultLength = 0;
  let truncated = false;
  let sawToolCall = false;
  let collectingPostToolResult = false;
  const activeToolCalls = new Set();
  const touched = new Set();

  const resetResult = () => {
    resultChunks.length = 0;
    resultLength = 0;
    truncated = false;
  };
  const appendResult = (text) => {
    if (truncated) return;
    const remaining = MAX_OUTPUT - resultLength;
    if (text.length <= remaining) {
      resultChunks.push(text);
      resultLength += text.length;
    } else if (remaining > 0) {
      resultChunks.push(text.slice(0, remaining));
      resultLength += remaining;
      truncated = true;
    } else {
      truncated = true;
    }
  };
  const isTerminalToolStatus = (status) =>
    status === "completed" || status === "failed" || status === "cancelled";
  const startTool = (toolCallId, status) => {
    sawToolCall = true;
    collectingPostToolResult = false;
    resetResult();
    if (toolCallId != null && !isTerminalToolStatus(status)) activeToolCalls.add(toolCallId);
    if (isTerminalToolStatus(status) && activeToolCalls.size === 0) collectingPostToolResult = true;
  };
  const updateToolStatus = (toolCallId, status) => {
    if (!status) return;
    if (!sawToolCall) {
      sawToolCall = true;
      resetResult();
    }
    if (isTerminalToolStatus(status)) {
      if (toolCallId != null) activeToolCalls.delete(toolCallId);
      if (activeToolCalls.size === 0 && !collectingPostToolResult) {
        // Discard any message text emitted while tools were still running.
        // A duplicate or late terminal update must not wipe an already-collected final message.
        resetResult();
        collectingPostToolResult = true;
      }
    } else {
      collectingPostToolResult = false;
      resetResult();
      if (toolCallId != null) activeToolCalls.add(toolCallId);
    }
  };

  // Each stream reports its newest complete sentence, at most one per throttle window.
  // Capital-letter boundary: cursor-agent thoughts arrive as sentences with no separator.
  const SENTENCE_END = /[.!?](?=\s|[A-Z])|\n/;
  const MARKDOWN_LINE = /^(?:[|#>`~*_=+-]|\d+[.)]\s)/;
  const progressStream = (prefix) => {
    let buf = "", pending = null, lastEmit = 0;
    const flush = (force) => {
      if (pending === null || (!force && Date.now() - lastEmit < progressThrottleMs)) return;
      lastEmit = Date.now();
      try { onProgress?.(prefix + pending); } catch {}
      pending = null;
    };
    const take = (s) => {
      const line = s.replace(/\s+/g, " ").trim().slice(0, 200);
      if (line.length > 3 && !MARKDOWN_LINE.test(line)) pending = line;
      flush(false);
    };
    return {
      push(text) {
        buf += text;
        for (let m; (m = SENTENCE_END.exec(buf)); buf = buf.slice(m.index + 1)) {
          take(buf.slice(0, m.index + 1));
        }
        if (buf.length > 300) { take(buf); buf = ""; }
      },
      end() { take(buf); buf = ""; flush(true); },
      reset() { buf = ""; pending = null; },
    };
  };
  const thoughtProgress = progressStream("thinking: ");
  const messageProgress = progressStream("Cursor: ");

  client.on("update", (u) => {
    const up = u?.update || {};
    if (up.sessionUpdate === "plan") {
      planEntries = up.entries || [];
    }
    if (up.sessionUpdate === "agent_thought_chunk" && up.content?.text) {
      thoughtProgress.push(up.content.text);
    }
    if (up.sessionUpdate === "tool_call") {
      startTool(up.toolCallId, up.status);
      const label = up.title || up.kind || "tool";
      const path = up.locations?.[0]?.path;
      const line = "running: " + String(label) + (path ? " — " + path : "");
      try { onProgress?.(line.slice(0, 200)); } catch {}
    }
    if (up.sessionUpdate === "agent_message_chunk" && up.content?.text) {
      const text = up.content.text;
      if (!sawToolCall || (collectingPostToolResult && activeToolCalls.size === 0)) appendResult(text);
      messageProgress.push(text);
    }
    if (up.sessionUpdate === "tool_call_update") {
      updateToolStatus(up.toolCallId, up.status);
      for (const c of up.content || []) {
        if (c.type === "diff" && c.path) {
          touched.add(c.path);
          try { onProgress?.("editing " + c.path); } catch {}
        }
      }
    }
  });

  try {
    let sessionId;
    const res = await supervisor.supervise(async () => {
      await client.start();
      await client.initialize();
      const sess = await openSession(client, resumeSessionId, workspace);
      sessionId = sess.sessionId;
      supervisor.setSessionId(sessionId);
      onSessionReady?.(sessionId, client);
      await client.setModel(sessionId, model);
      if (composerFastToggleApplies(model)) await client.setFast(sessionId, fast);
      await client.setMode(sessionId, mode);
      resetResult();
      sawToolCall = false;
      collectingPostToolResult = false;
      activeToolCalls.clear();
      thoughtProgress.reset();
      messageProgress.reset();
      planEntries = [];
      planOverview = undefined;
      planDetail = undefined;
      touched.clear();
      return client.prompt(sessionId, resolveSpec(spec));
    });
    thoughtProgress.end();
    messageProgress.end();
    let result = resultChunks.join("");
    if (truncated) result += TRUNCATION_MARKER;
    const finalMessageAvailable = result.length > 0;
    const resultSource = finalMessageAvailable
      ? (sawToolCall ? "post-tool" : "tool-free-stream")
      : "none";
    const protocolWarnings = [];
    let stopReason;
    if (res?.stopReason !== undefined) {
      if (typeof res.stopReason === "string") stopReason = res.stopReason;
      else protocolWarnings.push("stopReason dropped: ACP requires a string stop reason");
    }
    const out = {
      result,
      resultSource,
      finalMessageAvailable,
      stopReason,
      sessionId,
      filesReportedByAgent: normalizeAgentReportedFiles([...touched], workspace),
      questionsAsked,
      resumed: !!resumeSessionId && sessionId === resumeSessionId,
    };
    if (planEntries.length > 0 || planOverview !== undefined || planDetail !== undefined) {
      out.plan = sanitizePlan(protocolWarnings);
    }
    if (protocolWarnings.length) out.protocolWarnings = protocolWarnings;
    return out;
  } catch (err) {
    try {
      const transcript = client.getTranscript?.(40);
      if (transcript) err.message += "\n\n--- recent ACP transcript (last 40 frames) ---\n" + transcript;
    } catch {}
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { supervisor.finish(); } catch {}
    client.stop();
  }
}
