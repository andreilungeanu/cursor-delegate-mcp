import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { AcpClient } from "./acp-client.js";
import { SessionSupervisor } from "./session-supervisor.js";
import { normalizeAgentReportedFiles } from "./agent-reported-files.js";

export const DEFAULT_MODEL = "composer-2.5";
export const DEFAULT_HANDSHAKE_MS = 60000;
export const DEFAULT_HEARTBEAT_MS = 30000;

// Malformed values fall back to the default rather than failing the call.
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

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

const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};
// Base64 inflates by a third and every byte lands in the prompt, unlike a link.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A resource_link hands the agent a path instead of the file's bytes, so a large brief costs
// prompt space only for what the agent decides to open. Images cannot work that way — they
// are sent inline. Both are measured working, including links to files outside the
// workspace. Two rules follow from the probe:
//   - gate images on the advertised capability, because cursor-agent accepts blocks it does
//     not support without any error (embeddedContext:false raises nothing), so an ungated
//     image would silently vanish;
//   - report anything skipped, since a dropped attachment is otherwise invisible.
function buildContextBlocks(contextFiles, workspace, client, warnings) {
  const blocks = [];
  for (const entry of contextFiles || []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const abs = path.resolve(workspace || process.cwd(), entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      warnings.push(`contextFile ${entry} skipped: not found at ${abs}`);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`contextFile ${entry} skipped: not a file`);
      continue;
    }
    const mimeType = IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (mimeType) {
      if (!client?.agentCapabilities?.promptCapabilities?.image) {
        warnings.push(`contextFile ${entry} skipped: this agent does not accept image prompts`);
        continue;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        warnings.push(`contextFile ${entry} skipped: ${Math.round(stat.size / 1024)}KB exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB image limit`);
        continue;
      }
      blocks.push({ type: "image", mimeType, data: readFileSync(abs).toString("base64") });
      continue;
    }
    blocks.push({ type: "resource_link", uri: pathToFileURL(abs).href, name: path.basename(abs) });
  }
  return blocks;
}

async function openSession(client, resumeSessionId, workspace) {
  if (!resumeSessionId) return client.newSession(workspace);
  try {
    await client.loadSession(resumeSessionId, workspace);
    return { sessionId: resumeSessionId }; // load does not echo sessionId
  } catch (err) {
    // Starting fresh is right, but silently doing so leaves the caller unable to tell a
    // stale id from a typo'd one — keep why the load failed.
    const fresh = await client.newSession(workspace);
    return { ...fresh, resumeError: err?.message || String(err) };
  }
}

// session/new reports the models the agent actually offers. Reject an unknown id here,
// where the real list can be named, rather than letting set_model fail without it.
// Agents that report no list are left alone.
function assertKnownModel(client, model) {
  const available = client?.sessionModels?.availableModels;
  if (!Array.isArray(available) || available.length === 0) return;
  const ids = available.map((m) => m?.modelId).filter((id) => typeof id === "string");
  if (ids.length === 0 || ids.includes(model)) return;
  const err = new Error(`Unknown model ${JSON.stringify(model)}. This agent offers: ${ids.join(", ")}.`);
  err.reason = "unknown-model";
  throw err;
}

// Which config options a model carries is not discoverable up front: session/new reports
// configOptions for the default model and set_model returns nothing. So ask, and read the
// rejection as the answer. Two distinct -32602s, both measured: "Unknown model config
// option: X" means this model has no such knob — report it and carry on. "Invalid value
// for X: Y" means the caller named a value the model rejects, which must not be swallowed.
// Returns true when the option is unsupported.
async function applyConfig(client, sessionId, configId, value) {
  try {
    await client.setConfigOption(sessionId, configId, value);
    return false;
  } catch (err) {
    if (err?.code !== -32602 || !/unknown model config option/i.test(err?.message || "")) throw err;
    return true;
  }
}

export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model = DEFAULT_MODEL, fast = false, reasoning, context, contextFiles, clientFactory, onElicit,
  idleMs, handshakeMs, hardCapMs, timeoutMs,
  onSessionReady, onProgress, progressThrottleMs = 2000,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  signal,
} = {}) {
  if (signal?.aborted) {
    const err = new Error("delegation aborted by MCP host");
    err.reason = "aborted";
    throw err;
  }
  const capMs = hardCapMs ?? timeoutMs ?? envMs("CURSOR_DELEGATE_HARD_CAP_MS", 3600000);
  const shakeMs = handshakeMs ?? envMs("CURSOR_DELEGATE_HANDSHAKE_MS", DEFAULT_HANDSHAKE_MS);
  const turnIdleMs = idleMs ?? envMs("CURSOR_DELEGATE_IDLE_MS", 0);
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

  // merge:false replaces the list, merge:true upserts by id. Entries always arrive complete,
  // so a keyed set is enough — no field-level merging.
  let todos = new Map();
  let sawTodoFrame = false;
  const todoLabel = () => {
    const entries = [...todos.values()].filter((t) => typeof t?.content === "string");
    if (!entries.length) return null;
    const i = entries.findIndex((t) => t.status === "in_progress");
    if (i !== -1) return `todo ${i + 1}/${entries.length}: ${entries[i].content}`;
    const done = entries.filter((t) => t.status === "completed").length;
    return `todos ${done}/${entries.length} complete`;
  };
  const recordTodos = ({ todos: incoming, merge }) => {
    if (!Array.isArray(incoming)) return;
    sawTodoFrame = true;
    if (merge === false) todos = new Map();
    for (const t of incoming) {
      if (t?.id === undefined || t?.id === null) continue;
      todos.set(String(t.id), t);
    }
    const label = todoLabel();
    if (label) { try { onProgress?.(label.slice(0, 200)); } catch {} }
  };

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

  const TODO_STATUSES = ["pending", "in_progress", "completed"];
  const sanitizeTodos = (warnings) => {
    const entries = [];
    let i = -1;
    for (const raw of todos.values()) {
      i++;
      if (typeof raw?.content !== "string") {
        warnings.push(`todo ${i} dropped: expected string content, got ${raw === null ? "null" : typeof raw?.content}`);
        continue;
      }
      const status = TODO_STATUSES.includes(raw.status) ? raw.status : undefined;
      if (raw.status !== undefined && status === undefined) {
        warnings.push(`todo ${i}: unknown status ${JSON.stringify(raw.status)} removed`);
      }
      entries.push({ id: String(raw.id), content: raw.content, ...(status ? { status } : {}) });
    }
    const count = (s) => entries.filter((e) => e.status === s).length;
    return {
      todos: entries,
      todoProgress: {
        total: entries.length,
        completed: count("completed"),
        inProgress: count("in_progress"),
        pending: count("pending"),
      },
    };
  };

  const make = clientFactory || ((opts) => new AcpClient(opts));
  const client = make({ onElicit: wrappedElicit, mode, onCreatePlan: recordCreatePlan, onTodos: recordTodos });
  const supervisor = new SessionSupervisor(client, { idleMs: turnIdleMs, handshakeMs: shakeMs, hardCapMs: capMs });
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

  // The bridge cannot see inside a running shell command, so a long silence is reported
  // rather than acted on: the caller gets elapsed time and frame age and can decide.
  let lastToolLabel = null;
  let modeChanged;
  let sessionTitle;
  let promptInFlight = false;
  let heartbeat = null;
  const startHeartbeat = () => {
    if (!(heartbeatMs > 0)) return;
    const startedAt = Date.now();
    heartbeat = setInterval(() => {
      const parts = [
        `still working — ${fmtDuration(Date.now() - startedAt)} elapsed`,
        `last agent frame ${fmtDuration(supervisor.msSinceActivity())} ago`,
      ];
      const todo = todoLabel();
      if (todo) parts.push(todo);
      if (lastToolLabel) parts.push(`running: ${lastToolLabel}`);
      try { onProgress?.(parts.join(", ").slice(0, 200)); } catch {}
    }, heartbeatMs);
    heartbeat.unref?.();
  };

  // session/load replays the previous turn as ordinary session/update frames, including
  // tool_call and diff blocks. The reset before the prompt clears the state they touch,
  // but it cannot unsend the progress notifications they already emitted — a resume
  // otherwise reports the previous turn's tool calls and edits as if they were happening.
  client.on("update", (u) => {
    if (!promptInFlight) return;
    const up = u?.update || {};
    if (up.sessionUpdate === "plan") {
      planEntries = up.entries || [];
    }
    // A plan-mode run that switches itself to agent mode becomes write-capable while the
    // caller still believes nothing can change. No drift has been observed; report it so
    // we find out rather than assume.
    if (up.sessionUpdate === "current_mode_update" && up.currentModeId && up.currentModeId !== mode) {
      modeChanged = { from: mode, to: up.currentModeId };
    }
    // The agent names the turn a beat after the prompt lands ("File Creator"). Cheap
    // label for a caller juggling several delegations.
    if (up.sessionUpdate === "session_info_update" && typeof up.title === "string" && up.title) {
      sessionTitle = up.title;
    }
    if (up.sessionUpdate === "agent_thought_chunk" && up.content?.text) {
      thoughtProgress.push(up.content.text);
    }
    if (up.sessionUpdate === "tool_call") {
      startTool(up.toolCallId, up.status);
      const label = up.title || up.kind || "tool";
      const path = up.locations?.[0]?.path;
      lastToolLabel = String(label) + (path ? " — " + path : "");
      try { onProgress?.(("running: " + lastToolLabel).slice(0, 200)); } catch {}
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
        // cursor-agent has never been observed emitting these; ACP allows an agent to
        // stream tool output this way, so treat it like message text rather than drop it.
        if (c.type === "content" && typeof c.content?.text === "string") {
          if (!sawToolCall || (collectingPostToolResult && activeToolCalls.size === 0)) appendResult(c.content.text);
          messageProgress.push(c.content.text);
        }
      }
    }
  });

  let sessionId;
  let resumeError;
  const unsupportedOptions = [];
  const contextWarnings = [];
  try {
    const res = await supervisor.supervise(async () => {
      await client.start();
      await client.initialize();
      const sess = await openSession(client, resumeSessionId, workspace);
      sessionId = sess.sessionId;
      resumeError = sess.resumeError;
      supervisor.setSessionId(sessionId);
      onSessionReady?.(sessionId, client);
      assertKnownModel(client, model);
      await client.setModel(sessionId, model);
      // fast is always sent: a resumed session may already have it on, so false is a real
      // instruction. reasoning and context are only sent when the caller named one.
      if (await applyConfig(client, sessionId, "fast", fast) && fast) unsupportedOptions.push("fast");
      for (const [id, value] of [["reasoning", reasoning], ["context", context]]) {
        if (value === undefined) continue;
        if (await applyConfig(client, sessionId, id, value)) unsupportedOptions.push(id);
      }
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
      todos = new Map();
      sawTodoFrame = false;
      touched.clear();
      lastToolLabel = null;
      modeChanged = undefined;
      sessionTitle = undefined;
      supervisor.promptStarted();
      startHeartbeat();
      promptInFlight = true;
      return client.prompt(sessionId, [
        { type: "text", text: resolveSpec(spec) },
        ...buildContextBlocks(contextFiles, workspace, client, contextWarnings),
      ]);
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
    if (sessionTitle) out.sessionTitle = sessionTitle;
    if (resumeError) protocolWarnings.push(`resuming ${resumeSessionId} failed, started a fresh session: ${resumeError}`);
    for (const id of unsupportedOptions) protocolWarnings.push(`model ${model} has no ${id} option; the requested value was ignored`);
    protocolWarnings.push(...contextWarnings);
    if (planEntries.length > 0 || planOverview !== undefined || planDetail !== undefined) {
      out.plan = sanitizePlan(protocolWarnings);
    }
    // Most successful turns emit no todos at all, so an empty list would read as "nothing
    // done" rather than "not tracked". Report only what the agent actually sent.
    if (sawTodoFrame) Object.assign(out, sanitizeTodos(protocolWarnings));
    if (modeChanged) {
      out.modeChanged = modeChanged;
      protocolWarnings.push(`agent switched mode from ${modeChanged.from} to ${modeChanged.to} mid-session`);
    }
    if (protocolWarnings.length) out.protocolWarnings = protocolWarnings;
    return out;
  } catch (err) {
    // A JSON-RPC code means the agent rejected something rather than the bridge breaking.
    // Classifying it here is what lets the caller tell "fix your arguments" from "retry".
    if (!err?.reason && typeof err?.code === "number") err.reason = "agent-error";
    // A bare duration says nothing about whether the agent wedged or a command was just
    // slow. Name what was outstanding so the caller can tell the two apart, and so a
    // retry can resume from the work already done instead of restarting blind.
    const isTimeout = err?.reason === "hard-cap" || err?.reason === "idle-timeout";
    if (isTimeout || err?.reason === "aborted" || err?.reason === "agent-exit") {
      const age = fmtDuration(supervisor.msSinceActivity());
      err.message += `\n\nLast ACP frame ${age} ago${lastToolLabel ? `; last tool call: ${lastToolLabel}` : ""}.`;
      if (sessionTitle) err.message += ` The agent titled this turn ${JSON.stringify(sessionTitle)}.`;
      if (sawTodoFrame) {
        const { todoProgress } = sanitizeTodos([]);
        const current = todoLabel();
        err.message += ` ${todoProgress.completed} of ${todoProgress.total} todos completed`
          + `${current ? `; ${current}` : ""}.`;
      }
      const files = normalizeAgentReportedFiles([...touched], workspace);
      if (files.length) err.message += ` Files reported edited: ${files.join(", ")}.`;
      // Without this the resume hint below reads as "carry on from where you were", when the
      // requested session was never loaded and this turn started from nothing.
      if (resumeError) {
        err.message += ` Note: resuming ${resumeSessionId} had already failed (${resumeError}),`
          + ` so this ran as a fresh session and none of that earlier work was in context.`;
      }
      if (sessionId) err.message += ` Resume with resumeSessionId ${sessionId}.`;
      if (isTimeout) {
        err.message += " cursor-agent does not stream shell output over ACP, so a long-running command emits"
          + " nothing until it exits. Split the command, run it in the background and poll, or raise"
          + " CURSOR_DELEGATE_HARD_CAP_MS.";
      }
    }
    // Opt-in, because the frames land in the caller's context and nothing there is
    // actionable: the forensics above already carry everything a caller can act on. Raw
    // frames only help someone debugging the bridge, and that has always been done with a
    // protocol probe, never with an error dump.
    const frames = Number(process.env.CURSOR_DELEGATE_TRANSCRIPT);
    if (frames > 0) {
      try {
        const transcript = client.getTranscript?.(frames);
        if (transcript) err.message += `\n\n--- recent ACP transcript (last ${frames} frames) ---\n` + transcript;
      } catch {}
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", onAbort);
    try { supervisor.finish(); } catch {}
    client.stop();
  }
}
