import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { statSync, realpathSync } from "node:fs";
// Async: a sync read would stall every other delegation on this thread. The statSync calls stay
// sync: they validate arguments before the spawn.
import { readFile } from "node:fs/promises";
import { AcpClient } from "./acp-client.js";
import { DEFAULT_HARD_CAP_MS, SessionSupervisor } from "./session-supervisor.js";
import { normalizeAgentReportedFiles } from "./agent-reported-files.js";
import { makeTurnState } from "./turn-state.js";
import { makeError } from "./errors.js";
import { PLAN_PRIORITIES, PLAN_STATUSES, TODO_STATUSES } from "./acp-enums.js";
import { effortSettings, optionsFrom, resolveEffort, unsupportedWarning } from "./model-options.js";
import { transcriptFrames } from "./jsonrpc.js";

export const DEFAULT_MODEL = "composer-2.5";
// The one advertised id the agent resolves to a different model ("Auto"), so it is the one id
// whose served model has to be read back off a config reply for effectiveModel.
const ROUTED_MODEL = "default";
export const DEFAULT_HANDSHAKE_MS = 60000;
export const DEFAULT_HEARTBEAT_MS = 30000;

// A malformed or non-positive value falls back to the default, so a blank var (Number("") is 0)
// cannot arm a zero-length deadline.
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

// A blank spec costs a billed turn that only replies "No prompt content provided".
function assertSpec(spec) {
  if (typeof spec === "string" && spec.trim() === "") {
    throw makeError("invalid-spec", "spec is empty. Provide a task brief.");
  }
}

// Required, never defaulted: under npx or a plugin launch the server's cwd is a cache directory or
// the user's home, where an auto-approved agent would then work. Must exist, or the agent's first
// write turns a typo into a new empty tree.
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

// A resource_link hands the agent a path, so a file costs prompt space only if opened; it works
// outside the workspace too. Images have no such form and go inline, gated on the advertised
// capability: cursor-agent drops an unsupported block without error. Every skip is reported.
async function buildContextBlocks(contextFiles, workspace, client, warnings) {
  const blocks = [];
  // A glob plus an explicit path can resolve to one file; sending it twice wastes prompt space.
  const seen = new Set();
  // One warning for every miss, since a wrong workspace misses them all at once. Other skip
  // reasons are reported per entry.
  const notFound = [];
  const root = path.resolve(workspace || process.cwd());
  const identKey = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  for (const entry of contextFiles || []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const abs = path.resolve(workspace || process.cwd(), entry);
    let canonical;
    try {
      canonical = realpathSync(abs);
    } catch {
      const missKey = identKey(abs);
      if (seen.has(missKey)) continue;
      seen.add(missKey);
      notFound.push(entry);
      continue;
    }
    const key = identKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try {
      stat = statSync(canonical);
    } catch {
      notFound.push(entry);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`contextFile ${entry} skipped: not a file`);
      continue;
    }
    const mimeType = IMAGE_MIME[path.extname(canonical).toLowerCase()];
    if (mimeType) {
      if (!client?.agentCapabilities?.promptCapabilities?.image) {
        warnings.push(`contextFile ${entry} skipped: this agent does not accept image prompts`);
        continue;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        warnings.push(`contextFile ${entry} skipped: ${Math.round(stat.size / 1024)}KB exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB image limit`);
        continue;
      }
      try {
        blocks.push({ type: "image", mimeType, data: (await readFile(canonical)).toString("base64") });
      } catch (err) {
        warnings.push(`contextFile ${entry} skipped: could not read image (${err?.code || "read failed"})`);
      }
      continue;
    }
    blocks.push({ type: "resource_link", uri: pathToFileURL(canonical).href, name: path.basename(canonical) });
  }
  if (notFound.length) {
    warnings.push(
      `contextFile${notFound.length > 1 ? "s" : ""} skipped: ${notFound.length} not found under ${root}`
      + ` — ${notFound.join(", ")}`
    );
  }
  return blocks;
}

// Only a missing session justifies a fresh one. Code and wording together: 2026.08.11 returns
// -32602 `Session "<id>" not found` when missing, but -32603 `Failed to load session "<id>": <cause>`
// when restore fails, and the cause can carry the same words. A missed match costs a recoverable
// resume-failed; a false one, a turn run without the caller's context.
function isMissingSession(err) {
  const message = err?.message || "";
  return err?.code === -32602
    && /\bsession\b/i.test(message)
    && /\bnot found\b|\bdoes not exist\b|\bunknown session\b|\bno such session\b/i.test(message);
}

// The request and code of an error the agent answered with, as " (session/new JSON-RPC -32603)"; else "".
function rpcNote(err) {
  if (err?.reason || typeof err?.code !== "number") return "";
  return ` (${err.method ? `${err.method} ` : ""}JSON-RPC ${err.code})`;
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
        `session ${resumeSessionId} could not be loaded: ${err?.message || String(err)}${rpcNote(err)}.`
        + ` The session was not resumed and no fresh session was started — retry, or omit`
        + ` resumeSessionId to start fresh deliberately.`
      );
    }
    // Kept so the caller can tell a stale id from a mistyped one.
    const fresh = await client.newSession(workspace);
    return { ...fresh, resumeError: err?.message || String(err) };
  }
}

// Rejected here, where session/new's model list can be named; set_model's own error does not.
// Agents that report no list are left alone.
function assertKnownModel(client, model) {
  const available = client?.sessionModels?.availableModels;
  if (!Array.isArray(available) || available.length === 0) return;
  const ids = available.map((m) => m?.modelId).filter((id) => typeof id === "string");
  if (ids.length === 0 || ids.includes(model)) return;
  throw makeError("unknown-model", `Unknown model ${JSON.stringify(model)}. This agent offers: ${ids.join(", ")}.`);
}

// Options are not discoverable up front (session/new reports only the default model's; set_model
// returns nothing), so probe and read the rejection. Measured -32602s: "Unknown model config
// option: X" means no such knob (report, carry on); "Invalid value for X: Y" propagates.
// res echoes the current model's configOptions, the only place the served model id appears.
async function applyConfig(client, sessionId, configId, value) {
  try {
    const res = await client.setConfigOption(sessionId, configId, value);
    return { unsupported: false, res };
  } catch (err) {
    if (err?.code !== -32602 || !/unknown model config option/i.test(err?.message || "")) throw err;
    return { unsupported: true };
  }
}

// session/new and session/load report the values the session opens with, so a set that would
// change nothing can be skipped.
function configOptionValue(configOptions, id) {
  const opt = (Array.isArray(configOptions) ? configOptions : []).find((o) => o?.id === id);
  return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
}

// Undefined when the model rejected every option sent; effectiveModel then stays off.
function servedModelFrom(res) {
  const opts = optionsFrom(res);
  if (opts === undefined) return undefined;
  const m = opts.find((o) => o?.id === "model");
  return typeof m?.currentValue === "string" ? m.currentValue : undefined;
}

// Sent only as an exact value of an effort option the selected model advertised, so a bad token
// never reaches a billed prompt. Missing capability data is not reported as a caller mistake.
async function applyEffort(client, sessionId, model, value, modelOptions) {
  const resolved = resolveEffort(modelOptions, value);
  if (resolved.status === "unavailable") {
    throw makeError(
      "effort-options-unavailable",
      `Cannot validate effort ${JSON.stringify(value)} for ${JSON.stringify(model)}:`
        + " the selected model did not report a usable effort option list."
    );
  }
  if (resolved.status === "unrecognized") {
    throw makeError(
      "invalid-effort",
      `Model ${JSON.stringify(model)} advertised no option the bridge recognizes as effort.`
        + ` Advertised: ${JSON.stringify(resolved.advertised)}.`
        + ` If none of these is an effort setting, omit effort; do not send ${JSON.stringify("none")}.`
        + " If one is, the bridge failed to recognize it — report that rather than retrying."
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
 *   handshakeMs?: number, hardCapMs?: number, timeoutMs?: number,
 *   onSessionReady?: (sessionId: string, client: any) => void,
 *   onPromptSent?: (sessionId: string, resumeNote?: string) => void,
 *   onTurnEnd?: () => void,
 *   onProgress?: (message: string) => void,
 *   progressThrottleMs?: number, heartbeatMs?: number, signal?: AbortSignal,
 * }} [opts]
 */
export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model = DEFAULT_MODEL, fast = false, effort, context, contextFiles, clientFactory,
  handshakeMs, hardCapMs, timeoutMs,
  onSessionReady, onPromptSent, onTurnEnd, onProgress, progressThrottleMs = 2000,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  signal,
} = {}) {
  // No await before the abort listener below: addEventListener does not replay an abort that
  // already fired. Throw, not supervisor.abort(): tripping before supervise() installs its reject
  // settles the supervisor with nothing listening.
  if (signal?.aborted) {
    throw makeError("aborted", "delegation aborted by MCP host.");
  }
  // Before the spawn: validating later costs a process, a handshake and a billed turn.
  assertWorkspace(workspace);
  assertSpec(spec);
  const promptText = spec;
  const capMs = hardCapMs ?? timeoutMs ?? envMs("CURSOR_DELEGATE_HARD_CAP_MS", DEFAULT_HARD_CAP_MS);
  const shakeMs = handshakeMs ?? envMs("CURSOR_DELEGATE_HANDSHAKE_MS", DEFAULT_HANDSHAKE_MS);
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
        cancelled: count("cancelled"),
      },
    };
  };

  const make = clientFactory || ((opts) => new AcpClient(opts));
  const client = make({ mode, onCreatePlan: state.recordCreatePlan, onTodos: state.recordTodos });
  const supervisor = new SessionSupervisor(client, { handshakeMs: shakeMs, hardCapMs: capMs });
  const onAbort = () => supervisor.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  // The bridge cannot see inside a running shell command, so a long silence is reported
  // rather than acted on: the caller gets elapsed time and frame age and can decide.
  let promptInFlight = false;
  let heartbeat = null;
  const startHeartbeat = () => {
    // Setup orphaned by a trip must not arm a timer the teardown has already cleared.
    if (!(heartbeatMs > 0) || supervisor.settled) return;
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

  // Malformed frames seen mid-turn; merged into protocolWarnings at the end.
  const frameWarnings = [];

  // One line of at most 200 characters for progress and a stall error's "last tool call": a
  // command's title is the command verbatim, a whole script included.
  const labelTool = (started) => {
    const { title, path } = state.lastTool;
    const label = (String(title) + (path && !String(title).includes(path) ? " — " + path : "")).replace(/\s+/g, " ").trim().slice(0, 200);
    if (!started && label === state.lastToolLabel) return;
    state.lastToolLabel = label;
    try { onProgress?.(("running: " + label).slice(0, 200)); } catch {}
  };

  // session/load replays the previous turn as ordinary updates. state.reset() clears what they
  // set; only this guard keeps them out of progress.
  client.on("update", (u) => {
    if (!promptInFlight) return;
    const up = u?.update || {};
    if (up.sessionUpdate === "plan") {
      // A non-array would reach the sanitizer's forEach and throw after the work is done.
      if (up.entries !== undefined && !Array.isArray(up.entries)) {
        frameWarnings.push(
          `plan entries dropped: ACP requires an array, got ${up.entries === null ? "null" : typeof up.entries}`
        );
        state.planEntries = [];
      } else {
        state.planEntries = up.entries || [];
      }
    }
    // The agent's turn title ("File Creator"): a live label and timeout forensics. Kept out of the
    // result, where it has contradicted the answer ("No Image Detected" on an image turn).
    if (up.sessionUpdate === "session_info_update" && typeof up.title === "string" && up.title) {
      if (up.title !== state.sessionTitle) { try { onProgress?.(`turn titled: ${up.title}`.slice(0, 200)); } catch {} }
      state.sessionTitle = up.title;
    }
    if (up.sessionUpdate === "agent_thought_chunk" && up.content?.text) {
      state.thoughts.push(up.content.text);
    }
    if (up.sessionUpdate === "tool_call") {
      state.startTool(up.toolCallId, up.status);
      state.lastTool = { id: up.toolCallId, title: up.title || up.kind || "tool", path: up.locations?.[0]?.path };
      labelTool(true);
    }
    if (up.sessionUpdate === "agent_message_chunk" && up.content?.text) {
      const text = up.content.text;
      if (state.collectingResult()) state.appendResult(text);
      state.messages.push(text);
    }
    if (up.sessionUpdate === "tool_call_update") {
      state.updateToolStatus(up.toolCallId, up.status);
      // tool_call names only the kind ("Terminal", "Edit File"); the command or path comes on a
      // later update for the same id. Only the newest call is relabelled.
      const tool = state.lastTool;
      if (tool && up.toolCallId != null && up.toolCallId === tool.id) {
        const path = up.locations?.[0]?.path;
        if (typeof up.title === "string" && up.title.trim()) tool.title = up.title;
        if (typeof path === "string" && path) tool.path = path;
        labelTool(false);
      }
      // Array.isArray, not `|| []`: iterating a non-array throws in the readline callback, an
      // uncaught exception that takes down the whole server.
      for (const c of Array.isArray(up.content) ? up.content : []) {
        if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.type !== "string"
          || (c.type === "diff" && (typeof c.path !== "string" || !c.path))) {
          const warning = "malformed tool content dropped: expected content blocks with string diff paths";
          if (!frameWarnings.includes(warning)) frameWarnings.push(warning);
          continue;
        }
        if (c.type === "diff") {
          state.touched.add(c.path);
          try { onProgress?.("editing " + c.path); } catch {}
        }
      }
    }
  });

  let sessionId;
  let resumeError;
  // Otherwise a resume hint reads as continuing work this session never had.
  const resumeNote = () => (resumeError
    ? `resuming ${resumeSessionId} had already failed (${resumeError}), so this ran as a fresh session and none of that earlier work was in context.`
    : undefined);
  const unsupportedOptions = [];
  let servedModel;
  let effectiveEffort;
  const contextWarnings = [];
  // Set before the teardown in finally, which notes an unseen exit on whichever is going out.
  /** @type {any} */
  let out;
  /** @type {{ cause: any, reason?: string, notes: string[] } | undefined} */
  let failure;
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
      // A session serves the model it reports opening on, so a matching id needs no set_model
      // (measured). Cursor carries the selection across sessions, which makes this the usual case.
      const openedOnModel = client.sessionModels?.currentModelId === model;
      if (!openedOnModel) await client.setModel(sessionId, model);
      // The selected model's options as last reported, for effectiveEffort: dropped after a model
      // switch, replaced by each accepted set's reply (which may carry none), kept through a refused one.
      let observedOptions = openedOnModel ? client.configOptions : undefined;
      // fast is always sent as meant, never probed. Cursor persists the tier per model (measured),
      // so the opening value counts only when the session opened on this model. Skip the set only
      // when it did and the value matches, and send anyway when the reply is needed: effort needs
      // its option list, a routed id the served model. An absent value counts as a mismatch. effort
      // and context go only when named; the last reply seen wins.
      const openedFast = configOptionValue(client.configOptions, "fast");
      let modelOptions;
      if (!openedOnModel || openedFast !== String(fast) || effort !== undefined || model === ROUTED_MODEL) {
        const fastResult = await applyConfig(client, sessionId, "fast", fast);
        if (fastResult.unsupported && fast) unsupportedOptions.push({ arg: "fast" });
        else servedModel = servedModelFrom(fastResult.res) ?? servedModel;
        if (!fastResult.unsupported) observedOptions = optionsFrom(fastResult.res);
        modelOptions = optionsFrom(fastResult.res);
      }
      // A model that refuses fast leaves no list. Re-asserting the model just set is inert, and
      // its reply carries the full list — measured on claude-haiku-4-5, which refuses fast.
      if (modelOptions === undefined && effort !== undefined) {
        const reasserted = await applyConfig(client, sessionId, "model", model);
        modelOptions = optionsFrom(reasserted.res);
        if (!reasserted.unsupported) observedOptions = modelOptions;
        servedModel = servedModelFrom(reasserted.res) ?? servedModel;
      }
      if (effort !== undefined) {
        const r = await applyEffort(client, sessionId, model, effort, modelOptions);
        observedOptions = optionsFrom(r);
        servedModel = servedModelFrom(r) ?? servedModel;
      }
      if (context !== undefined) {
        const r = await applyConfig(client, sessionId, "context", context);
        if (r.unsupported) unsupportedOptions.push({ arg: "context" });
        else {
          observedOptions = optionsFrom(r.res);
          servedModel = servedModelFrom(r.res) ?? servedModel;
        }
      }
      await client.setMode(sessionId, mode);
      // What the agent reported, never the requested value standing in for an unconfirmed one.
      effectiveEffort = effortSettings(observedOptions);
      // Everything a session/load replay may have written belongs to the previous turn.
      state.reset();
      supervisor.promptStarted();
      startHeartbeat();
      try {
        const blocks = await buildContextBlocks(contextFiles, workspace, client, contextWarnings);
        // Raised with the prompt, so a frame sent while attachments were read is not folded in.
        promptInFlight = true;
        const turn = client.prompt(sessionId, [{ type: "text", text: promptText }, ...blocks]);
        // Every argument has been accepted by now, so a caller may stop waiting on the result.
        try { onPromptSent?.(sessionId, resumeNote()); } catch {}
        return await turn;
      } finally {
        // The result is assembled across later awaits; a frame trailing the turn must not join it.
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
        // end_turn is the normal case; only a refusal, a cancel or an output cap is surfaced.
        stopReason = res.stopReason;
      }
    }
    out = {
      result,
      sessionId,
    };
    // Absent means nothing reported, not nothing changed: shell edits leave no diff event.
    const filesReported = normalizeAgentReportedFiles([...state.touched], workspace);
    if (filesReported.length) out.filesReportedByEditTools = filesReported;
    // resultSource appears only when it warns; resumed only when a resume took (a failed one has
    // its own warning).
    if (resultSource !== "post-tool" && resultSource !== "tool-free-stream") out.resultSource = resultSource;
    if (!!resumeSessionId && sessionId === resumeSessionId) out.resumed = true;
    // Only when the agent served another model than asked ("default" routing, a cross-model resume).
    if (servedModel !== undefined && servedModel !== model) out.effectiveModel = servedModel;
    // Unlike effectiveModel, present whenever known: an omitted effort runs at whatever Cursor
    // saved for the model, and this is the only place the caller can see what that was.
    if (effectiveEffort !== undefined) out.effectiveEffort = effectiveEffort;
    if (stopReason !== undefined) out.stopReason = stopReason;
    if (resumeError) protocolWarnings.push(`resuming ${resumeSessionId} failed, started a fresh session: ${resumeError}`);
    for (const u of unsupportedOptions) protocolWarnings.push(unsupportedWarning(model, u));
    protocolWarnings.push(...contextWarnings);
    protocolWarnings.push(...frameWarnings);
    if (state.planEntries.length > 0 || state.planOverview !== undefined || state.planDetail !== undefined) {
      // Sanitized even when dropped: its warnings report malformed frames in any mode.
      const plan = sanitizePlan(protocolWarnings);
      // In plan/ask the result is the plan in prose; entries would put the same steps in context
      // twice, and the implementing resume reads the session, not this field. In agent mode the
      // result is the implementation report, so the plan stays.
      if (!dropPlan) out.plan = plan;
    }
    // Only when the agent tracked todos: an empty list would read as "nothing done". The list
    // itself only while items remain; once all are done it restates the counts.
    if (state.sawTodoFrame) {
      const { todos: todoList, todoProgress } = sanitizeTodos(protocolWarnings);
      out.todoProgress = todoProgress;
      if (todoProgress.completed < todoProgress.total) out.todos = todoList;
    }
    if (protocolWarnings.length) out.protocolWarnings = protocolWarnings;
    return out;
  } catch (err) {
    // A cancel before the prompt is the outcome the caller asked for: there was no turn to fail.
    if (err?.reason === "cancelled-in-setup" && sessionId) {
      out = { result: "", sessionId, resultSource: "none", stopReason: "cancelled" };
      if (resumeSessionId && sessionId === resumeSessionId) out.resumed = true;
      if (resumeError) out.protocolWarnings = [`resuming ${resumeSessionId} failed, started a fresh session: ${resumeError}`];
      return out;
    }
    // A JSON-RPC code means the agent answered with an error, not that the bridge broke: a rejected
    // argument (-32602) or a failure of its own (-32603).
    const fromAgent = !err?.reason && typeof err?.code === "number";
    const reason = err?.reason || (fromAgent ? "agent-error" : undefined);
    failure = { cause: err, reason, notes: [] };
    const { notes } = failure;
    if (fromAgent) notes.push(rpcNote(err));
    // A bare duration cannot distinguish a wedged agent from a slow command, so name what was
    // outstanding — it also lets a retry resume the work already done.
    const isTimeout = reason === "hard-cap";
    // A handshake timeout gets the forensics but not the long-command advice: no prompt was sent,
    // so no shell command explains the silence.
    const isStall = isTimeout || reason === "handshake-timeout";
    // Not on an abort: a cancelled request gets no response, and a cancelled task keeps its own
    // status message.
    if (isStall || reason === "agent-exit") {
      const age = fmtDuration(supervisor.msSinceActivity());
      notes.push(`\n\nLast ACP frame ${age} ago${state.lastToolLabel ? `; last tool call: ${state.lastToolLabel}` : ""}.`);
      if (state.sessionTitle) notes.push(` The agent titled this turn ${JSON.stringify(state.sessionTitle)}.`);
      if (state.sawTodoFrame) {
        const { todoProgress } = sanitizeTodos([]);
        const current = state.todoLabel();
        notes.push(` ${todoProgress.completed} of ${todoProgress.total} todos completed${current ? `; ${current}` : ""}.`);
      }
      const files = normalizeAgentReportedFiles([...state.touched], workspace);
      if (files.length) notes.push(` Files reported edited: ${files.join(", ")}.`);
    }
    if (resumeError) notes.push(` Note: ${resumeNote()}`);
    // Any failure after session/new leaves a resumable session, unknown-model and a rejected
    // config value included, not just the stalls.
    if (sessionId) notes.push(` Resume with resumeSessionId ${sessionId}.`);
    if (isTimeout) {
      notes.push(" cursor-agent does not stream shell output over ACP, so a long-running command emits"
        + " nothing until it exits. Split the command, run it in the background and poll, or raise CURSOR_DELEGATE_HARD_CAP_MS.");
    }
    // Opt-in: raw frames add nothing actionable to the caller's context beyond the forensics
    // above; they help only someone debugging the bridge.
    const frames = transcriptFrames();
    if (frames > 0) {
      try {
        const transcript = client.getTranscript?.(frames);
        if (transcript) notes.push(`\n\n--- recent ACP transcript (last ${frames} frames) ---\n` + transcript);
      } catch {}
    }
  } finally {
    // The turn is decided: from here a cancel finds nothing running.
    try { onTurnEnd?.(); } catch {}
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", onAbort);
    try { supervisor.finish(); } catch {}
    // Awaited: a host may close stdin on the result, and on Windows the server's exit does not take
    // a running agent with it (server.smoke.test.js). An exit not seen is noted instead, as is a
    // stop that rejects.
    let exited = false;
    try { exited = await client.stop(); } catch {}
    if (exited === false) {
      const pid = client.child?.pid;
      const note = `the bridge stopped cursor-agent${pid ? ` (pid ${pid})` : ""} but could not confirm that it and its processes exited; they may still be running.`;
      if (failure) failure.notes.push(` Note: ${note}`);
      else if (out) (out.protocolWarnings ??= []).push(note);
    }
  }
  // After teardown, so the exit note it adds is in the message.
  const { cause, reason, notes } = /** @type {NonNullable<typeof failure>} */ (failure);
  throw makeError(reason, (cause?.message || String(cause)) + notes.join(""), { code: cause?.code, cause });
}
