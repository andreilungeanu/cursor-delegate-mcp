import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { statSync } from "node:fs";
// Async: a sync read on the server's only thread stalls every other in-flight delegation and
// its progress stream. The statSync calls below stay sync — they are argument validation and
// run before the spawn.
import { readFile } from "node:fs/promises";
import { AcpClient } from "./acp-client.js";
import { SessionSupervisor } from "./session-supervisor.js";
import { normalizeAgentReportedFiles } from "./agent-reported-files.js";
import { makeTurnState } from "./turn-state.js";
import { makeError } from "./errors.js";
import { PLAN_PRIORITIES, PLAN_STATUSES, TODO_STATUSES } from "./acp-enums.js";
import { optionsFrom, resolveEffort, unsupportedWarning } from "./model-options.js";

export const DEFAULT_MODEL = "composer-2.5";
// The one advertised id the agent resolves to a different model ("Auto"), so it is the one id
// whose served model has to be read back off a config reply for effectiveModel.
const ROUTED_MODEL = "default";
export const DEFAULT_HANDSHAKE_MS = 60000;
export const DEFAULT_HEARTBEAT_MS = 30000;

// Malformed values fall back to the default rather than failing the call. Only a positive value
// counts, so a blank var (Number("") is 0) cannot arm a zero-length deadline. The idle guard's
// documented 0 comes from its own fallback being 0, not from an env value.
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// A blank spec spins up a live session that only replies "No prompt content provided" —
// a billed turn for nothing. Reject it before the spawn, like a bad workspace.
function assertSpec(spec) {
  if (typeof spec === "string" && spec.trim() === "") {
    throw makeError("invalid-spec", "spec is empty. Provide a task brief.");
  }
}

// Named, never defaulted: under npx or a plugin launch the server's own cwd is a cache directory
// or the user's home, so a defaulted workspace put an auto-approved agent to work on a tree
// nobody asked about while every layer reported success. And without the existence check the
// agent's first write creates the directory, so a typo spawns a parallel empty tree. Same check
// contextFiles applies.
function assertWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace.trim() === "") {
    throw makeError("invalid-workspace", "workspace is required. Name the directory the agent should work in.");
  }
  let stat;
  try {
    stat = statSync(workspace);
  } catch {
    throw makeError("invalid-workspace", `workspace ${workspace} does not exist. Create it first, or point at an existing directory.`);
  }
  if (!stat.isDirectory()) {
    throw makeError("invalid-workspace", `workspace ${workspace} is not a directory.`);
  }
}

const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};
// Base64 inflates by a third and every byte lands in the prompt, unlike a link.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A resource_link hands the agent a path, not the file's bytes, so a large brief costs prompt
// space only for what the agent opens. Images have no such form — they go inline. Both are
// measured working, including links outside the workspace. Two rules from that probe:
//   - gate images on the advertised capability: cursor-agent accepts unsupported blocks without
//     error (embeddedContext:false raises nothing), so an ungated image vanishes silently;
//   - report anything skipped — a dropped attachment is otherwise invisible.
async function buildContextBlocks(contextFiles, workspace, client, warnings) {
  const blocks = [];
  // A glob plus an explicit path can resolve to one file; sending it twice wastes prompt space.
  const seen = new Set();
  // Grouped, not one warning per file: a wrong workspace misses every attachment at once, and a
  // line each would repeat the same root N times for one root cause. The other skip reasons stay
  // per-entry — they are individually distinct and never arrive in bulk.
  const notFound = [];
  const root = path.resolve(workspace || process.cwd());
  for (const entry of contextFiles || []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const abs = path.resolve(workspace || process.cwd(), entry);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      notFound.push(entry);
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
      blocks.push({ type: "image", mimeType, data: (await readFile(abs)).toString("base64") });
      continue;
    }
    blocks.push({ type: "resource_link", uri: pathToFileURL(abs).href, name: path.basename(abs) });
  }
  if (notFound.length) {
    warnings.push(
      `contextFile${notFound.length > 1 ? "s" : ""} skipped: ${notFound.length} not found under ${root}`
      + ` — ${notFound.join(", ")}`
    );
  }
  return blocks;
}

// Only a session the agent does not have justifies a fresh one; falling back on anything else
// runs the task without the context the caller asked for. Code and wording together, never
// either: 2026.08.11 returns -32602 `Session "<id>" not found` when it is missing, but -32603
// `Failed to load session "<id>": <cause>` when restore fails, and that cause can carry the
// same words. A missed match costs a recoverable resume-failed; a false match costs a silent turn.
function isMissingSession(err) {
  const message = err?.message || "";
  return err?.code === -32602
    && /\bsession\b/i.test(message)
    && /\bnot found\b|\bdoes not exist\b|\bunknown session\b|\bno such session\b/i.test(message);
}

async function openSession(client, resumeSessionId, workspace) {
  if (!resumeSessionId) return client.newSession(workspace);
  try {
    await client.loadSession(resumeSessionId, workspace);
    return { sessionId: resumeSessionId }; // load does not echo sessionId
  } catch (err) {
    if (!isMissingSession(err)) {
      throw makeError(
        "resume-failed",
        `session ${resumeSessionId} could not be loaded: ${err?.message || String(err)}.`
        + ` The session was not resumed and no fresh session was started — retry, or omit`
        + ` resumeSessionId to start fresh deliberately.`
      );
    }
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
  throw makeError("unknown-model", `Unknown model ${JSON.stringify(model)}. This agent offers: ${ids.join(", ")}.`);
}

// A model's config options are not discoverable up front (session/new reports only the default
// model's; set_model returns nothing), so probe by asking and read the rejection. Both -32602s
// are measured: "Unknown model config option: X" means no such knob — report and carry on;
// "Invalid value for X: Y" is a caller error and must propagate.
// res echoes the now-current model's configOptions — the only place the served model id appears.
async function applyConfig(client, sessionId, configId, value) {
  try {
    const res = await client.setConfigOption(sessionId, configId, value);
    return { unsupported: false, res };
  } catch (err) {
    if (err?.code !== -32602 || !/unknown model config option/i.test(err?.message || "")) throw err;
    return { unsupported: true };
  }
}

// The resolved model appears only in a set_config_option reply's configOptions (set_model
// returns nothing). Absent for models that reject every option sent — the field then stays off.
// session/new and session/load both report the values the session opens with, which is what makes
// a config round-trip skippable: the bridge can see it would set what is already set.
function configOptionValue(configOptions, id) {
  const opt = (Array.isArray(configOptions) ? configOptions : []).find((o) => o?.id === id);
  return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
}

function servedModelFrom(res) {
  const opts = optionsFrom(res);
  if (opts === undefined) return undefined;
  const m = opts.find((o) => o?.id === "model");
  return typeof m?.currentValue === "string" ? m.currentValue : undefined;
}

// Sent only when the exact value appears under a thought-level option the selected model
// advertised. Local validation keeps a bad token out of ACP and, more importantly, out of a
// billed prompt. Missing capability data is not mislabeled as a caller mistake.
async function applyEffort(client, sessionId, model, value, modelOptions) {
  const resolved = resolveEffort(modelOptions, value);
  if (resolved.status === "unavailable") {
    throw makeError(
      "effort-options-unavailable",
      `Cannot validate effort ${JSON.stringify(value)} for ${JSON.stringify(model)}:`
        + " the selected model did not report a usable effort option list."
    );
  }
  if (resolved.status === "unsupported") {
    throw makeError(
      "invalid-effort",
      `Model ${JSON.stringify(model)} does not advertise configurable effort.`
        + ` Accepted: none. Omit effort; do not send ${JSON.stringify("none")}.`
    );
  }
  if (resolved.status === "invalid") {
    throw makeError(
      "invalid-effort",
      `Invalid effort ${JSON.stringify(value)} for ${JSON.stringify(model)}.`
        + ` Accepted: ${JSON.stringify(resolved.accepted)}.`
    );
  }

  const r = await applyConfig(client, sessionId, resolved.id, resolved.value);
  if (r.unsupported) {
    throw makeError(
      "effort-options-unavailable",
      `Cannot apply effort ${JSON.stringify(value)} for ${JSON.stringify(model)}:`
        + ` the selected model advertised option ${JSON.stringify(resolved.id)} but rejected it.`
    );
  }
  return r.res;
}

/**
 * @param {{
 *   spec?: string, mode?: string, resumeSessionId?: string, workspace?: string,
 *   model?: string, fast?: boolean, effort?: string, context?: string,
 *   contextFiles?: string[], clientFactory?: (opts: any) => any,
 *   idleMs?: number, handshakeMs?: number, hardCapMs?: number, timeoutMs?: number,
 *   onClientReady?: (client: any) => void,
 *   onSessionReady?: (sessionId: string, client: any) => void,
 *   onProgress?: (message: string) => void,
 *   progressThrottleMs?: number, heartbeatMs?: number, signal?: AbortSignal,
 * }} [opts]
 */
export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model = DEFAULT_MODEL, fast = false, effort, context, contextFiles, clientFactory,
  idleMs, handshakeMs, hardCapMs, timeoutMs,
  onClientReady, onSessionReady, onProgress, progressThrottleMs = 2000,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  signal,
} = {}) {
  // Nothing between here and the abort listener below may await: addEventListener does not
  // replay an abort that already fired, so an abort landing in that window would be lost. A
  // spec read used to await here, and did lose one. Throwing, not supervisor.abort(): tripping
  // before supervise() installs its reject settles the supervisor with nothing listening.
  if (signal?.aborted) {
    throw makeError("aborted", "delegation aborted by MCP host");
  }
  // Before the spawn: validating later costs a process, a handshake and a billed turn.
  assertWorkspace(workspace);
  assertSpec(spec);
  const promptText = spec;
  const capMs = hardCapMs ?? timeoutMs ?? envMs("CURSOR_DELEGATE_HARD_CAP_MS", 3600000);
  const shakeMs = handshakeMs ?? envMs("CURSOR_DELEGATE_HANDSHAKE_MS", DEFAULT_HANDSHAKE_MS);
  const turnIdleMs = idleMs ?? envMs("CURSOR_DELEGATE_IDLE_MS", 0);
  const state = makeTurnState({ onProgress, progressThrottleMs });

  // ACP requires string plan content and bounds priority/status. A frame that violates that must
  // not fail the MCP call after the work is done — drop the bad data, report it as a diagnostic.
  const sanitizePlan = (warnings) => {
    const entries = [];
    state.planEntries.forEach((raw, i) => {
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
    if (state.planOverview !== undefined) {
      if (typeof state.planOverview === "string") plan.overview = state.planOverview;
      else warnings.push("plan overview dropped: expected string");
    }
    if (state.planDetail !== undefined) {
      if (typeof state.planDetail === "string") plan.detail = state.planDetail;
      else warnings.push("plan detail dropped: expected string");
    }
    return plan;
  };

  const sanitizeTodos = (warnings) => {
    const entries = [];
    let i = -1;
    for (const raw of state.todos.values()) {
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
  const client = make({ mode, onCreatePlan: state.recordCreatePlan, onTodos: state.recordTodos });
  // Handed over before the spawn, because from client.start() there is an agent process and the
  // caller needs something that can stop it. onSessionReady is roughly 3.4s later — a host going
  // away inside that window used to exit with the agent already running and nothing holding it.
  onClientReady?.(client);
  const supervisor = new SessionSupervisor(client, { idleMs: turnIdleMs, handshakeMs: shakeMs, hardCapMs: capMs });
  const onAbort = () => supervisor.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  // The bridge cannot see inside a running shell command, so a long silence is reported
  // rather than acted on: the caller gets elapsed time and frame age and can decide.
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
      const todo = state.todoLabel();
      if (todo) parts.push(todo);
      if (state.lastToolLabel) parts.push(`running: ${state.lastToolLabel}`);
      try { onProgress?.(parts.join(", ").slice(0, 200)); } catch {}
    }, heartbeatMs);
    heartbeat.unref?.();
  };

  // Malformed frames noticed as they arrive, where protocolWarnings does not exist yet. Merged
  // into it with the rest below.
  const frameWarnings = [];

  // session/load replays the previous turn as ordinary update frames, tool_call and diff blocks
  // included. state.reset() clears what they touch but cannot unsend a progress notification, so
  // the guard below is what stops a resume reporting last turn's edits as if they were happening.
  client.on("update", (u) => {
    if (!promptInFlight) return;
    const up = u?.update || {};
    if (up.sessionUpdate === "plan") {
      // ACP defines entries as an array. A non-array is truthy, so it was stored as-is and
      // reached the sanitizer's forEach — throwing after the turn's work was done, which is the
      // one thing the sanitizer exists to prevent. Drop it here and say so instead.
      if (up.entries !== undefined && !Array.isArray(up.entries)) {
        frameWarnings.push(
          `plan entries dropped: ACP requires an array, got ${up.entries === null ? "null" : typeof up.entries}`
        );
        state.planEntries = [];
      } else {
        state.planEntries = up.entries || [];
      }
    }
    // The agent titles the turn a beat after the prompt lands ("File Creator") — useful live,
    // when several delegations run, and in timeout forensics. Kept out of the result: there it
    // arrives too late to tell anything apart, and was measured contradicting the answer
    // ("No Image Detected" on a turn describing an image).
    if (up.sessionUpdate === "session_info_update" && typeof up.title === "string" && up.title) {
      if (up.title !== state.sessionTitle) { try { onProgress?.(`turn titled: ${up.title}`.slice(0, 200)); } catch {} }
      state.sessionTitle = up.title;
    }
    if (up.sessionUpdate === "agent_thought_chunk" && up.content?.text) {
      state.thoughts.push(up.content.text);
    }
    if (up.sessionUpdate === "tool_call") {
      state.startTool(up.toolCallId, up.status);
      const label = up.title || up.kind || "tool";
      const path = up.locations?.[0]?.path;
      // Collapsed onto one line the way both readers of this take it: a progress notification
      // and the "last tool call" line in a stall error. A terminal tool's title is the command
      // the agent sent, which it sends verbatim — a multi-line script arrives with its newlines.
      state.lastToolLabel = (String(label) + (path ? " — " + path : "")).replace(/\s+/g, " ").trim();
      try { onProgress?.(("running: " + state.lastToolLabel).slice(0, 200)); } catch {}
    }
    if (up.sessionUpdate === "agent_message_chunk" && up.content?.text) {
      const text = up.content.text;
      if (state.collectingResult()) state.appendResult(text);
      state.messages.push(text);
    }
    if (up.sessionUpdate === "tool_call_update") {
      state.updateToolStatus(up.toolCallId, up.status);
      // Array.isArray, not `|| []`: a non-array content is truthy and iterating it throws
      // "object is not iterable" here, in the readline callback, where nothing awaits it. That
      // is an uncaught exception — the whole server, not this one turn — and it also stops the
      // reply on the next line from being read, so the turn hangs to its cap.
      for (const c of Array.isArray(up.content) ? up.content : []) {
        if (c.type === "diff" && c.path) {
          state.touched.add(c.path);
          try { onProgress?.("editing " + c.path); } catch {}
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
      // session/new and session/load both report the model the session opened on, and an id that
      // already matches is served without an explicit set — measured, so this round-trip has
      // nothing to change. Cursor carries the selection across sessions, so the common shape
      // (same model twice running) hits this.
      const openedOnModel = client.sessionModels?.currentModelId === model;
      if (!openedOnModel) await client.setModel(sessionId, model);
      // fast is an instruction, not a probe. Cursor persists the tier, and persists it per model —
      // both measured: one fast:true turn leaves the next fresh session reporting fast=true, and a
      // set_model to another model reports that model's own tier. So the opening snapshot only
      // describes the tier in force when the session also opened on this model; after a switch it
      // describes the model we left. Skip only when both hold, which is the steady-state path this
      // is for, and send whenever the reply itself is read: effort needs its option list, and a
      // routable id needs the served model. An absent value reads as a mismatch and sends. effort
      // and context go only when the caller named one; the last reply seen wins.
      const openedFast = configOptionValue(client.configOptions, "fast");
      let modelOptions;
      if (!openedOnModel || openedFast !== String(fast) || effort !== undefined || model === ROUTED_MODEL) {
        const fastResult = await applyConfig(client, sessionId, "fast", fast);
        if (fastResult.unsupported && fast) unsupportedOptions.push({ arg: "fast" });
        else servedModel = servedModelFrom(fastResult.res) ?? servedModel;
        modelOptions = optionsFrom(fastResult.res);
      }
      // A model that refuses fast leaves no list. Re-asserting the model just set is inert, and
      // its reply carries the full list — measured on claude-haiku-4-5, which refuses fast.
      if (modelOptions === undefined && effort !== undefined) {
        const reasserted = await applyConfig(client, sessionId, "model", model);
        modelOptions = optionsFrom(reasserted.res);
        servedModel = servedModelFrom(reasserted.res) ?? servedModel;
      }
      if (effort !== undefined) {
        const r = await applyEffort(client, sessionId, model, effort, modelOptions);
        servedModel = servedModelFrom(r) ?? servedModel;
      }
      if (context !== undefined) {
        const r = await applyConfig(client, sessionId, "context", context);
        if (r.unsupported) unsupportedOptions.push({ arg: "context" });
        else servedModel = servedModelFrom(r.res) ?? servedModel;
      }
      await client.setMode(sessionId, mode);
      // Everything a session/load replay may have written belongs to the previous turn.
      state.reset();
      supervisor.promptStarted();
      startHeartbeat();
      promptInFlight = true;
      try {
        const blocks = await buildContextBlocks(contextFiles, workspace, client, contextWarnings);
        return await client.prompt(sessionId, [{ type: "text", text: promptText }, ...blocks]);
      } finally {
        // The result is assembled across awaits below, so without this a frame trailing the
        // settled turn is still folded into it.
        promptInFlight = false;
      }
    });
    state.thoughts.end();
    state.messages.end();
    let result = state.text();
    const finalMessageAvailable = result.length > 0;
    let resultSource = finalMessageAvailable
      ? (state.sawToolCall ? "post-tool" : "tool-free-stream")
      : "none";
    const protocolWarnings = [];
    // The mode alone decides this — no bridge-side comparison of prose against entries.
    const dropPlan = mode === "plan" || mode === "ask";
    if (!finalMessageAvailable && state.discardedResult) {
      result = state.discardedResult;
      resultSource = "pre-tool-fallback";
      protocolWarnings.push(
        "the agent ran a tool after its last message and never spoke again, so no final message closed the turn."
        + " result carries the last message before that tool call — it may be a preamble rather than the answer."
      );
    } else if (!finalMessageAvailable) {
      protocolWarnings.push("the agent ended the turn without emitting any message; result is empty.");
    }
    let stopReason;
    if (res?.stopReason !== undefined) {
      if (typeof res.stopReason !== "string") {
        protocolWarnings.push("stopReason dropped: ACP requires a string stop reason");
      } else if (res.stopReason !== "end_turn") {
        // end_turn carries no signal (it was end_turn on every stress-test call). Surface a stop
        // reason only when something happened: a refusal, a cancel, an output cap.
        stopReason = res.stopReason;
      }
    }
    const out = {
      result,
      sessionId,
    };
    // Absence means "nothing reported", not "nothing changed" — a claim this field cannot make,
    // since shell-driven edits leave no diff event.
    const filesReported = normalizeAgentReportedFiles([...state.touched], workspace);
    if (filesReported.length) out.filesReportedByEditTools = filesReported;
    // resultSource is a caveat, not a fact: on the happy path (post-tool / tool-free-stream)
    // result is just the answer. Emit it only when it warns. resumed likewise appears only when a
    // resume took — a fresh session or a failed one (which carries its own warning) leaves it off.
    if (resultSource !== "post-tool" && resultSource !== "tool-free-stream") out.resultSource = resultSource;
    if (!!resumeSessionId && sessionId === resumeSessionId) out.resumed = true;
    // Only when the agent served a different model than asked — e.g. "default" routing to a
    // concrete id, or a cross-model resume. Silence means the request was honored.
    if (servedModel !== undefined && servedModel !== model) out.effectiveModel = servedModel;
    if (stopReason !== undefined) out.stopReason = stopReason;
    // sessionTitle stays out of the result: it is a live label (progress) and a forensic one
    // (timeout errors), not a fact about the finished turn.
    if (resumeError) protocolWarnings.push(`resuming ${resumeSessionId} failed, started a fresh session: ${resumeError}`);
    for (const u of unsupportedOptions) protocolWarnings.push(unsupportedWarning(model, u));
    protocolWarnings.push(...contextWarnings);
    protocolWarnings.push(...frameWarnings);
    if (state.planEntries.length > 0 || state.planOverview !== undefined || state.planDetail !== undefined) {
      // Sanitize even when the plan is discarded: the warnings it raises report malformed ACP
      // frames, which the caller needs whatever mode it asked for.
      const plan = sanitizePlan(protocolWarnings);
      // In plan/ask, result IS the plan — the agent's own message, already prose and already
      // what gets shown to the user for approval. Returning entries alongside it puts the same
      // steps in the orchestrator's context twice, and nothing consumes them: the resume that
      // implements reads the agent's own session, not this field. In agent mode result is the
      // implementation report, a separate artifact from the plan, so the whole object stays.
      if (!dropPlan) out.plan = plan;
    }
    // Most turns emit no todos, so an empty list would read as "nothing done" rather than "not
    // tracked". The full list is carried only when it says what todoProgress cannot — which items
    // remain; on a fully-completed turn it just restates the counts.
    if (state.sawTodoFrame) {
      const { todos: todoList, todoProgress } = sanitizeTodos(protocolWarnings);
      out.todoProgress = todoProgress;
      if (todoProgress.completed < todoProgress.total) out.todos = todoList;
    }
    if (protocolWarnings.length) out.protocolWarnings = protocolWarnings;
    return out;
  } catch (err) {
    // A JSON-RPC code means the agent rejected something rather than the bridge breaking — the
    // distinction a caller needs to tell "fix your arguments" from "retry".
    if (!err?.reason && typeof err?.code === "number") err.reason = "agent-error";
    // A bare duration cannot distinguish a wedged agent from a slow command, so name what was
    // outstanding — it also lets a retry resume the work already done.
    const isTimeout = err?.reason === "hard-cap" || err?.reason === "idle-timeout";
    // A handshake timeout gets the forensics but not the long-command advice: no prompt was sent,
    // so no shell command explains the silence.
    const isStall = isTimeout || err?.reason === "handshake-timeout";
    if (isStall || err?.reason === "aborted" || err?.reason === "agent-exit") {
      const age = fmtDuration(supervisor.msSinceActivity());
      err.message += `\n\nLast ACP frame ${age} ago${state.lastToolLabel ? `; last tool call: ${state.lastToolLabel}` : ""}.`;
      if (state.sessionTitle) err.message += ` The agent titled this turn ${JSON.stringify(state.sessionTitle)}.`;
      if (state.sawTodoFrame) {
        const { todoProgress } = sanitizeTodos([]);
        const current = state.todoLabel();
        err.message += ` ${todoProgress.completed} of ${todoProgress.total} todos completed`
          + `${current ? `; ${current}` : ""}.`;
      }
      const files = normalizeAgentReportedFiles([...state.touched], workspace);
      if (files.length) err.message += ` Files reported edited: ${files.join(", ")}.`;
    }
    // Every failure after session/new leaves a live session, not just the stalls: the id is set
    // before set_model/set_config_option/set_mode, so unknown-model and a rejected config value
    // land here too and are abandoned without it.
    if (resumeError) {
      // Without this the resume hint reads as "carry on from where you were", when the requested
      // session was never loaded.
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
    // Opt-in: the frames land in the caller's context and nothing there is actionable — the
    // forensics above already carry that. Raw frames only help someone debugging the bridge.
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
    // Deliberately not awaited: stop() waits for the child to exit, and every turn — success as
    // much as failure — would pay that before returning. Nothing here reads whether it landed.
    Promise.resolve(client.stop()).catch(() => {});
  }
}
