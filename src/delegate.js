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

// Cutting a UTF-16 string at an arbitrary index can split a surrogate pair and leave a lone
// half-character — ill-formed Unicode that strict JSON consumers reject or mangle. Step back
// one unit when the boundary would land inside a pair.
function cutAtCodePoint(s, n) {
  if (n >= s.length) return s;
  const cu = s.charCodeAt(n - 1);
  return s.slice(0, cu >= 0xd800 && cu <= 0xdbff ? n - 1 : n);
}

// Two different questions, and conflating them is what made a typo'd brief cost a live turn.
// "Could this be a path?" is deliberately loose — a one-line brief ending in .md is worth a
// stat. "Was a path clearly intended?" has to be strict, because an ordinary inline spec
// mentions files ("fix the bug in src/api.js") and must never be rejected for it. Whitespace
// is the discriminator: a path argument has none, a sentence about a path does.
function looksLikeSpecPath(spec) {
  return !spec.includes("\n")
    && (spec.includes("/") || spec.includes("\\") || spec.endsWith(".md") || spec.endsWith(".txt"));
}
const isBareSpecPath = (spec) => !/\s/.test(spec.trim());

function resolveSpec(spec) {
  if (typeof spec !== "string") return spec;
  // A blank spec spins up a live session that only replies "No prompt content provided" —
  // a billed turn for nothing. Reject it here, before the spawn, like the other bad specs.
  if (spec.trim() === "") {
    const err = new Error("spec is empty. Provide a task brief inline, or a path to one.");
    err.reason = "invalid-spec";
    throw err;
  }
  if (!looksLikeSpecPath(spec)) return spec;
  let stat;
  try {
    stat = statSync(spec);
  } catch {
    // Only a bare path was unambiguously meant as one. Anything else is prose that happens
    // to name a file, and prose is the common case.
    if (!isBareSpecPath(spec)) return spec;
    const err = new Error(`spec looks like a file path but nothing exists at ${spec}. Pass the brief inline, or fix the path.`);
    err.reason = "invalid-spec";
    throw err;
  }
  if (stat.isFile()) return readFileSync(spec, "utf8");
  if (isBareSpecPath(spec)) {
    const err = new Error(`spec looks like a file path but ${spec} is not a file. Pass the brief inline, or point at a file.`);
    err.reason = "invalid-spec";
    throw err;
  }
  return spec;
}

// A nonexistent workspace was accepted, then created by the agent's first write — a typo
// silently spawned a parallel empty tree and every layer reported success. contextFiles has
// always rejected the same mistakes; this is that check, applied to its sibling.
function assertWorkspace(workspace) {
  if (workspace === undefined || workspace === null) return;
  let stat;
  try {
    stat = statSync(workspace);
  } catch {
    const err = new Error(`workspace ${workspace} does not exist. Create it first, or point at an existing directory.`);
    err.reason = "invalid-workspace";
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`workspace ${workspace} is not a directory.`);
    err.reason = "invalid-workspace";
    throw err;
  }
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
  // A glob plus an explicit path (or the same file named a few ways) resolves to one file;
  // sending it several times just wastes prompt space. Collapse by resolved absolute path.
  const seen = new Set();
  for (const entry of contextFiles || []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const abs = path.resolve(workspace || process.cwd(), entry);
    if (seen.has(abs)) continue;
    seen.add(abs);
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
// Returns { unsupported, res }: unsupported is true when the model has no such knob; res is the
// set_config_option reply, which echoes the now-current model's configOptions (incl. the served
// model id) — the only place the agent reports what model actually took after set_model.
async function applyConfig(client, sessionId, configId, value) {
  try {
    const res = await client.setConfigOption(sessionId, configId, value);
    return { unsupported: false, res };
  } catch (err) {
    if (err?.code !== -32602 || !/unknown model config option/i.test(err?.message || "")) throw err;
    return { unsupported: true };
  }
}

// The agent reports the resolved model only inside a set_config_option reply's configOptions
// (set_model itself returns nothing). Read it there when present; absent for models that reject
// every option we send, which is fine — the field then stays off.
function servedModelFrom(res) {
  const opts = res?.configOptions;
  if (!Array.isArray(opts)) return undefined;
  const m = opts.find((o) => o?.id === "model");
  return typeof m?.currentValue === "string" ? m.currentValue : undefined;
}

export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model = DEFAULT_MODEL, fast = false, reasoning, context, contextFiles, clientFactory,
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
  // Before the spawn: a bad path is the caller's to fix, and finding out costs a process,
  // a handshake and a billed turn if it waits until the prompt is assembled.
  assertWorkspace(workspace);
  const promptText = resolveSpec(spec);
  const capMs = hardCapMs ?? timeoutMs ?? envMs("CURSOR_DELEGATE_HARD_CAP_MS", 3600000);
  const shakeMs = handshakeMs ?? envMs("CURSOR_DELEGATE_HANDSHAKE_MS", DEFAULT_HANDSHAKE_MS);
  const turnIdleMs = idleMs ?? envMs("CURSOR_DELEGATE_IDLE_MS", 0);
  const MAX_OUTPUT = 10 * 1024 * 1024;
  const TRUNCATION_MARKER = "\n\n[output truncated at 10MB]";
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
  const client = make({ mode, onCreatePlan: recordCreatePlan, onTodos: recordTodos });
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

  // Text superseded by a later tool call is normally a preamble ("Inspecting the
  // implementation.") and returning it would be inventing a summary. But the rule cannot
  // tell a preamble from the whole answer: an agent that replies and then runs one more
  // command has its entire reply discarded, and the caller gets "" with stopReason end_turn
  // and no error. So keep the last discarded segment and hand it back only when nothing
  // survived — labelled, never blended with a real final message.
  let discardedResult = "";
  const resetResult = () => {
    if (resultLength > 0) discardedResult = resultChunks.join("");
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
      const cut = cutAtCodePoint(text, remaining);
      resultChunks.push(cut);
      resultLength += cut.length;
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
  // A shell write arrives as execute, a file write as edit; delete and move round out ACP's
  // write-capable kinds. read, search, think and fetch stay out — a plan turn is expected
  // to do those.
  const WRITE_CAPABLE_KINDS = new Set(["edit", "delete", "move", "execute"]);
  // Scoped to plan/ask deliberately. In agent mode this is every turn and carries nothing;
  // in plan/ask a disk-touching turn is abnormal — the plan itself travels over ACP as a
  // string via cursor/create_plan, not as a file — so the base rate makes it worth reading.
  // It records what the agent *ran*, never what changed: a command is not a change list.
  const WRITE_ACTIVITY_CAP = 20;
  const watchingWrites = mode === "plan" || mode === "ask";
  let writeCapableActivity = [];
  let writeActivityById = new Map();
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
    // The agent names the turn a beat after the prompt lands ("File Creator"). Useful as an
    // ephemeral label while several delegations run, and in timeout forensics — but not in
    // the result, where it arrives after there is nothing left to tell apart and has been
    // measured contradicting the answer ("No Image Detected" on a turn describing an image).
    if (up.sessionUpdate === "session_info_update" && typeof up.title === "string" && up.title) {
      if (up.title !== sessionTitle) { try { onProgress?.(`turn titled: ${up.title}`.slice(0, 200)); } catch {} }
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
      if (watchingWrites && WRITE_CAPABLE_KINDS.has(up.kind) && writeCapableActivity.length < WRITE_ACTIVITY_CAP) {
        const entry = { kind: up.kind, detail: lastToolLabel.slice(0, 300) };
        writeCapableActivity.push(entry);
        // An execute call names itself — its title is the shell command. An edit call does
        // not: the title is a bare "Edit File" and locations is empty, so the only thing
        // separating docs/plan.md from src/api.js is the diff frame that follows. Keep the
        // id so that frame can fill the path in.
        if (up.toolCallId != null) writeActivityById.set(up.toolCallId, entry);
      }
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
          const pending = writeActivityById.get(up.toolCallId);
          if (pending && !pending.path) {
            pending.path = normalizeAgentReportedFiles([c.path], workspace)[0];
          }
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
  let servedModel;
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
      // instruction. reasoning and context are only sent when the caller named one. Each reply
      // reports the now-current model; keep the last one seen as the served model.
      const fastResult = await applyConfig(client, sessionId, "fast", fast);
      if (fastResult.unsupported && fast) unsupportedOptions.push("fast");
      else servedModel = servedModelFrom(fastResult.res) ?? servedModel;
      for (const [id, value] of [["reasoning", reasoning], ["context", context]]) {
        if (value === undefined) continue;
        const r = await applyConfig(client, sessionId, id, value);
        if (r.unsupported) unsupportedOptions.push(id);
        else servedModel = servedModelFrom(r.res) ?? servedModel;
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
      discardedResult = "";
      writeCapableActivity = [];
      writeActivityById = new Map();
      touched.clear();
      lastToolLabel = null;
      modeChanged = undefined;
      sessionTitle = undefined;
      supervisor.promptStarted();
      startHeartbeat();
      promptInFlight = true;
      return client.prompt(sessionId, [
        { type: "text", text: promptText },
        ...buildContextBlocks(contextFiles, workspace, client, contextWarnings),
      ]);
    });
    thoughtProgress.end();
    messageProgress.end();
    let result = resultChunks.join("");
    if (truncated) result += TRUNCATION_MARKER;
    const finalMessageAvailable = result.length > 0;
    let resultSource = finalMessageAvailable
      ? (sawToolCall ? "post-tool" : "tool-free-stream")
      : "none";
    const protocolWarnings = [];
    // plan.detail is the model restating — into chat's sibling channel — a plan it also filed via
    // create_plan; cursor-agent narrates across the IDE's two surfaces and here they flatten into
    // one ACP payload. The detail is never load-bearing: the plan lives in the agent's own session
    // (which is what a resume-to-implement reads, not this field) and the orchestrator approves
    // from result + plan.entries. So in plan/ask keep the plan in one prose channel — drop the
    // detail as a duplicate when result already is a real plan message, fold it into result when
    // the message is too terse (or a fallback preamble) to be the plan itself. In agent mode the
    // plan was accepted and result is the implementation report, a separate artifact — both stay.
    const PLAN_TERSE_FLOOR = 200;
    let dropPlanDetail = false;
    if (typeof planDetail === "string" && (mode === "plan" || mode === "ask")) {
      dropPlanDetail = true;
      if (!(finalMessageAvailable && result.length >= PLAN_TERSE_FLOOR)) {
        // The terse floor cannot tell a trivial "FILED." from a real question — a question is
        // always short. Promotion overwrites result with the plan, so never let it silently
        // eat the agent's own words: carry a real final message under the plan. A pre-tool
        // preamble (no final message) stays dropped — it is not the agent's closing reply.
        const suppressed = finalMessageAvailable ? result : "";
        result = planDetail;
        if (suppressed.trim() && suppressed !== planDetail) {
          result += "\n\n--- agent chat reply:\n" + suppressed;
        }
        resultSource = "plan-detail";
      }
    }
    if (resultSource !== "plan-detail") {
      if (!finalMessageAvailable && discardedResult) {
        result = discardedResult;
        resultSource = "pre-tool-fallback";
        protocolWarnings.push(
          "the agent ran a tool after its last message and never spoke again, so no final message closed the turn."
          + " result carries the last message before that tool call — it may be a preamble rather than the answer."
        );
      } else if (!finalMessageAvailable) {
        protocolWarnings.push("the agent ended the turn without emitting any message; result is empty.");
      }
    }
    let stopReason;
    if (res?.stopReason !== undefined) {
      if (typeof res.stopReason !== "string") {
        protocolWarnings.push("stopReason dropped: ACP requires a string stop reason");
      } else if (res.stopReason !== "end_turn") {
        // end_turn is the near-universal default and carries no signal — it was end_turn on
        // every call across the stress test. Surface a stop reason only when it says something
        // happened: a refusal, a cancel, an output cap. Absence means the ordinary end_turn.
        stopReason = res.stopReason;
      }
    }
    const out = {
      result,
      sessionId,
    };
    // Like every other collection here, absence means "nothing reported": an empty list on
    // every read-only turn read as a claim that nothing changed, which this field cannot make
    // (shell-driven edits leave no diff event).
    const filesReported = normalizeAgentReportedFiles([...touched], workspace);
    if (filesReported.length) out.filesReportedByEditTools = filesReported;
    // resultSource is a caveat, not a fact worth stating on every turn: on the happy path
    // (post-tool / tool-free-stream) result is simply the answer, so say nothing. Surface it only
    // when it warns — pre-tool-fallback, plan-detail, none. finalMessageAvailable is dropped
    // outright: it stated the same thing in a second boolean. resumed is emitted only when a
    // resume actually took; a fresh session or a failed resume (which carries its own warning)
    // leaves it absent.
    if (resultSource !== "post-tool" && resultSource !== "tool-free-stream") out.resultSource = resultSource;
    if (!!resumeSessionId && sessionId === resumeSessionId) out.resumed = true;
    // Only when the agent served a different model than asked — e.g. "default" routing to a
    // concrete id, or a cross-model resume. Silence means the request was honored.
    if (servedModel !== undefined && servedModel !== model) out.effectiveModel = servedModel;
    if (stopReason !== undefined) out.stopReason = stopReason;
    // sessionTitle stays out of the result: it is a live label (progress) and a forensic one
    // (timeout errors), not a fact about the finished turn.
    if (resumeError) protocolWarnings.push(`resuming ${resumeSessionId} failed, started a fresh session: ${resumeError}`);
    for (const id of unsupportedOptions) protocolWarnings.push(`model ${model} has no ${id} option; the requested value was ignored`);
    protocolWarnings.push(...contextWarnings);
    if (planEntries.length > 0 || planOverview !== undefined || planDetail !== undefined) {
      out.plan = sanitizePlan(protocolWarnings);
      // In plan/ask the plan is already carried by result (a real message, or folded in per the
      // one-plan contract above), so the detail here is a duplicate — drop it. entries and
      // overview are structured and unique, and always stay.
      if (dropPlanDetail) delete out.plan.detail;
    }
    // Most successful turns emit no todos at all, so an empty list would read as "nothing
    // done" rather than "not tracked". Report only what the agent actually sent — and of
    // that, the full list only when it says something todoProgress cannot: which items
    // remain. On a fully-completed turn the list restates the counts entry by entry.
    if (sawTodoFrame) {
      const { todos: todoList, todoProgress } = sanitizeTodos(protocolWarnings);
      out.todoProgress = todoProgress;
      if (todoProgress.completed < todoProgress.total) out.todos = todoList;
    }
    if (writeCapableActivity.length) {
      out.writeCapableActivity = writeCapableActivity;
      // A pathless execute may be read-only (git log) or a shell write with no edit-tool
      // path, so infer nothing from paths: name what ran and let the diff decide.
      const anyPath = writeCapableActivity.some((a) => a.path);
      protocolWarnings.push(
        `mode ${mode} asked the agent not to change anything, but it ran ${writeCapableActivity.length}`
        + ` write-capable tool call${writeCapableActivity.length === 1 ? "" : "s"} — see writeCapableActivity`
        + " for what ran"
        + (anyPath
          ? ", and the diff for what changed."
          : "; none reported a file through edit tools — the diff is authoritative, review it.")
      );
    }
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
    // A handshake timeout gets the forensics but not the long-command advice below: the
    // session exists by then — it is set before set_model, set_config_option and set_mode,
    // any of which can hang — so the resume hint is what the caller needs. No prompt was
    // ever sent, so no shell command can be the reason for the silence.
    const isStall = isTimeout || err?.reason === "handshake-timeout";
    if (isStall || err?.reason === "aborted" || err?.reason === "agent-exit") {
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
        // Name the knob that actually fired: raising the hard cap does nothing for an
        // idle-timeout, whose ceiling is CURSOR_DELEGATE_IDLE_MS.
        const knob = err.reason === "idle-timeout" ? "CURSOR_DELEGATE_IDLE_MS" : "CURSOR_DELEGATE_HARD_CAP_MS";
        err.message += " cursor-agent does not stream shell output over ACP, so a long-running command emits"
          + ` nothing until it exits. Split the command, run it in the background and poll, or raise ${knob}.`;
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
