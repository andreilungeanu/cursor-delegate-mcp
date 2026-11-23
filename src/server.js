#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { DEFAULT_MODEL, runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION, readPackageVersion } from "./version.js";
import { DETACHED } from "./proc.js";
import { PLAN_PRIORITIES, PLAN_STATUSES, TODO_STATUSES } from "./acp-enums.js";

const ICON_BASE = `https://raw.githubusercontent.com/andreilungeanu/cursor-delegate-mcp/v${VERSION}/assets`;
/** @type {Array<{ src: string, mimeType: string, sizes: string[], theme: "light" | "dark" }>} */
const SERVER_ICONS = [
  { src: `${ICON_BASE}/logo-light.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "light" },
  { src: `${ICON_BASE}/logo-dark.png`, mimeType: "image/png", sizes: ["1024x1024"], theme: "dark" },
];

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`cursor-delegate-mcp requires Node 20+ (found ${process.versions.node})`);
  process.exit(1);
}

// sessionId -> the delegations running on it. A set because a resume can race the turn it
// resumes; with one handle per id, whichever finished first deregistered the other.
const inFlight = new Map();
function registerInFlight(map, sessionId, handle) {
  const handles = map.get(sessionId);
  if (handles) handles.add(handle);
  else map.set(sessionId, new Set([handle]));
}
/** @returns {import("@modelcontextprotocol/server").CallToolResult} */
function cancelResult(status, sessionId) {
  return { content: [{ type: "text", text: JSON.stringify({ status, sessionId }) }] };
}
function unregisterInFlight(map, sessionId, handle) {
  const handles = map.get(sessionId);
  if (!handles) return;
  handles.delete(handle);
  if (handles.size === 0) map.delete(sessionId);
}
// Delegations whose session has not opened yet: the agent runs ~3.4s before inFlight can key it.
// Shutdown walks this; cancel cannot, since the caller has no id for these yet.
const pendingDelegations = new Set();

// Session ids seen by this process, kept after the turn ends so cancel can tell a finished
// (still resumable) session from an id that never existed. Bounded.
const seenSessions = new Set();
const SEEN_SESSIONS_CAP = 500;
function rememberSession(set, id) {
  if (id == null) return;
  // Delete-then-add makes the Set an LRU, so a session still being resumed outlives one seen once.
  if (set.has(id)) set.delete(id);
  set.add(id);
  if (set.size > SEEN_SESSIONS_CAP) set.delete(set.values().next().value);
}

// Read at connect, so only what decides whether to delegate at all. Call-time facts belong on
// the parameter descriptions.
export const SERVER_INSTRUCTIONS = `Delegate coding work to Cursor through the delegate tool. Every permission the agent requests is auto-approved, in every mode: agent/plan/ask reach any file the user account can, and mode instructs the agent rather than limiting it. Scope workspace tightly and review the git diff after every run — filesReportedByEditTools carries only what the agent's edit tools reported; the diff is authoritative.`;

const planEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(PLAN_PRIORITIES).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
}).passthrough();

// No outputSchema: it requires structuredContent too, and a host that reads both (Codex) puts the
// payload in context twice. Strict copy in delegate.test.js; field meanings in
// skills/delegate/reference.md.
export const delegateOutputShape = {
  result: z.string(),
  resultSource: z.enum(["pre-tool-fallback", "none"]).optional(),
  effectiveModel: z.string().optional(),
  effectiveEffort: z.record(z.string(), z.string()).optional(),
  stopReason: z.string().optional(),
  sessionId: z.string(),
  filesReportedByEditTools: z.array(z.string()).optional(),
  resumed: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  protocolWarnings: z.array(z.string()).optional(),
  plan: z.object({
    entries: z.array(planEntrySchema),
    overview: z.string().optional(),
    detail: z.string().optional(),
  }).optional(),
  todos: z.array(z.object({
    id: z.string(),
    content: z.string(),
    status: z.enum(TODO_STATUSES).optional(),
  })).optional(),
  todoProgress: z.object({
    total: z.number(),
    completed: z.number(),
    inProgress: z.number(),
    pending: z.number(),
    cancelled: z.number(),
  }).optional(),
};

// Same contract as delegateOutputShape; strict copy in doctor.test.js. Relayed agent fields stay
// unknown so an odd protocolVersion is a diagnostic, not a failed call. Handshake is its own
// shape because .strict() does not look inside a nested object.
export const doctorHandshakeShape = {
  ok: z.boolean(),
  error: z.string().optional(),
  protocolVersion: z.unknown().optional(),
  agentCapabilities: z.unknown().optional(),
  models: z.array(z.unknown()).optional(),
  currentModel: z.unknown().optional(),
  modes: z.array(z.unknown()).optional(),
  // Built here, not relayed, so it gets a real type.
  currentModelOptions: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    category: z.string().optional(),
    values: z.array(z.string()),
    currentValue: z.string().optional(),
  })).optional(),
};

export const doctorAgentShape = {
  found: z.boolean(),
  command: z.string(),
  version: z.string().nullable(),
  error: z.string().optional(),
  handshake: z.object(doctorHandshakeShape).passthrough().optional(),
};

// agent is split out for the same reason as handshake.
export const doctorOutputShape = {
  plugin: z.object({ version: z.string() }).passthrough(),
  client: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    capabilities: z.record(z.string(), z.unknown()),
    protocolVersion: z.string().optional(),
  }).passthrough(),
  agent: z.object(doctorAgentShape).passthrough(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    cwd: z.string(),
    transport: z.literal("stdio"),
  }),
  env: z.record(z.string(), z.unknown()),
};

export const delegateInputSchema = z.object({
  spec: z.string().trim().min(1, "spec must not be blank").describe("Task brief: goal, scope, fixed decisions quoted exactly, acceptance criteria. Sent as written. Point at files to read rather than pasting code, or attach them with contextFiles."),
  mode: z.enum(["agent", "plan", "ask"]).default("agent").describe("agent implements; plan and ask are instructions to the agent, not limits."),
  resumeSessionId: z.string().optional().describe("Continue an existing ACP session."),
  workspace: z.string().trim().min(1, "workspace must not be blank").describe("The agent's working directory, not a limit. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call."),
  model: z.string().trim().min(1, "model must be a non-empty string").default(DEFAULT_MODEL).describe("Bare ACP family id, version included: composer-2.5, grok-4.5, claude-opus-5, gpt-5.6-sol. doctor deep:true lists every id."),
  fast: z.boolean().default(false).describe("Fast tier; higher cost — only when the user asks."),
  // Open string: a model's values are known only once it is selected, then validated live.
  effort: z.string().trim().min(1).optional().describe("Exact Cursor thinking-effort value for the selected model. Values differ per model and some expose no effort option; invalid values fail before the prompt and name the accepted set. Pass only when the user asks for Cursor effort — the host's own reasoning setting is unrelated."),
  context: z.string().trim().min(1).optional().describe("Context window size; gpt-5.x accepts 272k and 1m. Do not pass speculatively."),
  contextFiles: z.array(z.string()).optional().describe("Paths to attach instead of pasting contents into spec. Text becomes references the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against workspace but are not limited to it. Skips are reported in protocolWarnings, never fatal."),
});

/**
 * @param {{
 *   args: any, ctx?: any,
 *   runDelegate: (opts: any) => Promise<any>,
 *   inFlight: Map<string, Set<any>>,
 *   pending?: Set<any>,
 *   seenSessions?: Set<string>,
 * }} deps
 * @returns {Promise<import("@modelcontextprotocol/server").CallToolResult>}
 */
export async function runDelegateTool({ args, ctx, runDelegate, inFlight, pending = new Set(), seenSessions = new Set() }) {
  const { spec, mode, resumeSessionId, workspace, model, fast, effort, context, contextFiles } = args;

  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  /** @type {(message: string) => void} */
  let onProgress = () => {};
  if (progressToken != null) {
    let progress = 0;
    onProgress = (message) => {
      // An unhandled rejection from notify would exit the server; the try catches a sync throw.
      try {
        Promise.resolve(ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: ++progress, message },
        })).catch(() => {});
      } catch {}
    };
  }

  let capturedSessionId;
  let handle;
  try {
    const out = await runDelegate({
      spec,
      mode,
      resumeSessionId,
      workspace,
      model,
      fast,
      effort,
      context,
      contextFiles,
      onProgress,
      signal: ctx?.mcpReq?.signal,
      onClientReady: (client) => {
        handle = { client, cancelRequested: false };
        pending.add(handle);
      },
      onSessionReady: (sessionId, client) => {
        capturedSessionId = sessionId;
        // The same handle moves across, so a racing shutdown finds it on exactly one side.
        handle ??= { client, cancelRequested: false };
        pending.delete(handle);
        registerInFlight(inFlight, sessionId, handle);
        rememberSession(seenSessions, sessionId);
        // Sent now so a host that can call tools concurrently has an id to cancel mid-run.
        onProgress(`session ready: ${sessionId}`);
      },
      onTurnEnd: () => { if (handle) handle.ended = true; },
    });
    if (handle?.cancelRequested) out.cancelRequested = true;
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  } catch (err) {
    return {
      // The reason up front, so the caller need not parse prose to tell a timeout from a bad argument.
      content: [{ type: "text", text: `delegate failed${err?.reason ? ` [${err.reason}]` : ""}: ` + (err?.message || String(err)) }],
      isError: true,
    };
  } finally {
    // Drops only this delegation's handle, from whichever of pending or the map holds it; the id
    // stays registered while another turn runs on it.
    if (handle) pending.delete(handle);
    if (capturedSessionId) unregisterInFlight(inFlight, capturedSessionId, handle);
  }
}

/**
 * @param {{
 *   runDelegate?: (opts: any) => Promise<any>,
 *   runDoctor?: (opts: any) => Promise<any>,
 *   forceGraceMs?: number,
 *   pending?: Set<any>,
 * }} [opts]
 */
export function buildServer({ runDelegate: runDelegateInjected, runDoctor: runDoctorInjected, forceGraceMs = 5000, pending = pendingDelegations } = {}) {
  const runDelegate = runDelegateInjected || runDelegateDefault;
  const runDoctor = runDoctorInjected || runDoctorDefault;
  const server = new McpServer(
    { name: "cursor-delegate-mcp", version: VERSION, icons: SERVER_ICONS },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "delegate",
    {
      description:
        `Delegate a coding task to cursor-agent over ACP. Never shell out to cursor-agent — use this tool only. Auto-approves every permission the agent requests, in any mode and anywhere on disk. Clarifying questions arrive as prose in result — resume with resumeSessionId to answer. Keep model (${DEFAULT_MODEL}), fast and effort at their defaults unless the user explicitly asks. See the delegate skill.`,
      inputSchema: delegateInputSchema,
      annotations: {
        title: "Delegate coding task to Cursor",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => runDelegateTool({ args, ctx, runDelegate, inFlight, pending, seenSessions })
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Best-effort cancel of an in-flight delegation by sessionId. session/cancel is advisory — the agent may finish the turn anyway, and the delegate result then carries cancelRequested. Status: cancelled, killed (agent process observed to exit), not-running (turn already ended, still resumable), not-found (id not in this process's recent session history).",
      inputSchema: z.object({
        // Blank is a malformed call, not a stale id.
        sessionId: z.string().trim().min(1, "sessionId must not be blank"),
        force: z.boolean().default(false).describe("Kill the agent process if the turn is still running after a short grace period."),
      }),
      annotations: {
        title: "Cancel Cursor delegation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, force }) => {
      const handles = inFlight.get(sessionId);
      if (!handles || handles.size === 0) {
        // A finished session is still resumable; only an unknown id is not-found.
        const known = seenSessions.has(sessionId);
        return cancelResult(known ? "not-running" : "not-found", sessionId);
      }
      // Every turn on the id (the caller named a session), taken now: a resume that registers during
      // the grace or the kill is not swept in. An ended turn stays registered while its agent is
      // stopped; its result is decided, so a cancel leaves it alone.
      const targeted = [...handles].filter((handle) => !handle.ended);
      if (targeted.length === 0) return cancelResult("not-running", sessionId);
      for (const handle of targeted) handle.cancelRequested = true;
      await Promise.all(targeted.map((handle) => handle.client.cancel(sessionId).catch(() => {})));
      if (!force) {
        // Handles stay registered: session/cancel is advisory, and a later force must still find
        // the turn. Each delegation's finally removes its handle when the turn settles.
        return cancelResult("cancelled", sessionId);
      }
      // Polled, not slept through: the turn often settles well inside the grace.
      const running = () => targeted.filter((handle) => !handle.ended && inFlight.get(sessionId)?.has(handle));
      const graceEnds = Date.now() + forceGraceMs;
      while (Date.now() < graceEnds && running().length) {
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, graceEnds - Date.now()))));
      }
      const toKill = running();
      if (toKill.length === 0) return cancelResult("cancelled", sessionId);
      const observed = await Promise.all(
        toKill.map((handle) => Promise.resolve(handle.client.stop()).catch(() => false))
      );
      // "killed" needs an observed exit; without one the handles stay and force can be retried.
      if (!observed.every(Boolean)) return cancelResult("cancelled", sessionId);
      for (const handle of toKill) unregisterInFlight(inFlight, sessionId, handle);
      return cancelResult("killed", sessionId);
    }
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Setup diagnostics: plugin version, MCP client capabilities, cursor-agent launcher resolution. Run when delegation fails or agent.found is false.",
      inputSchema: z.object({
        deep: z
          .boolean()
          .default(false)
          .describe("Run an ACP handshake (start → initialize → newSession) to verify the agent is usable; adds models, modes and the current model's options."),
      }),
      annotations: {
        title: "Diagnose Cursor delegation setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deep }, ctx) => {
      // doctor's processes sit in pending while it runs, where shutdown already looks.
      const handles = [];
      try {
        const out = await runDoctor({
          deep,
          signal: ctx?.mcpReq?.signal,
          onClientReady: (client) => { const handle = { client }; handles.push(handle); pending.add(handle); },
          getClientInfo: () => clientInfoOf(server, ctx),
        });
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } finally {
        for (const handle of handles) pending.delete(handle);
      }
    }
  );

  return server;
}

// A 2026-07-28 client sends its identity with each request; a 2025-era one sends it once, in
// initialize, which the server's getters return.
export function clientInfoOf(server, ctx) {
  const envelope = ctx?.mcpReq?.envelope;
  return {
    capabilities: envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities(),
    version: envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion(),
    protocolVersion: envelope?.[PROTOCOL_VERSION_META_KEY] ?? server.server.getNegotiatedProtocolVersion(),
  };
}

const __filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    // An imported module must not fail just because argv[1] is not a file.
  }
}

// Kill what is still running, then exit, on any way the host has of going away.
export function installSignalCleanup(map, {
  pending = new Set(),
  exit = (code) => process.exit(code),
  setExitCode = (code) => { process.exitCode = code; },
  schedule = (fn) => setImmediate(fn),
  stdin = process.stdin,
} = {}) {
  let shuttingDown = false;
  const shutdown = (code, fromSignal = false) => {
    // A second signal exits without the wait, the kills already sent. A stdin EOF does not: a
    // hangup closes stdin right after its SIGHUP.
    if (shuttingDown) return fromSignal ? exit(code) : undefined;
    shuttingDown = true;
    // Set now: the loop may run dry before the scheduled exit gets a turn.
    setExitCode(code);
    const stops = [];
    const dispatch = (handle) => {
      try { stops.push(Promise.resolve(handle.client.stop()).catch(() => {})); } catch {}
    };
    for (const handles of map.values()) for (const handle of handles) dispatch(handle);
    // Delegations still in their handshake: their agent runs, and only pending reaches it.
    for (const handle of pending) dispatch(handle);
    // Waits for the kills: on Windows taskkill is a separate process, and exiting first orphans the
    // launcher and agent below the shell (measured). stop() bounds itself, so the wait is finite.
    // The exit is scheduled onto a clean loop turn rather than run on the settlement stack.
    const leave = () => schedule(() => exit(code));
    Promise.all(stops).then(leave, leave);
  };
  // On POSIX each agent has its own process group, which a signal to this process misses, so the
  // handler kills them first. SIGHUP too: a closed terminal, whose default leaves them running.
  if (DETACHED) {
    const signals = /** @type {[NodeJS.Signals, number][]} */ ([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]);
    for (const [signal, code] of signals) process.on(signal, () => shutdown(code, true));
  }
  // A stdio host closes stdin before it resorts to a signal. On EOF the SDK closes its transport
  // and aborts in-flight requests, but nothing there stops cursor-agent.
  stdin.on("end", () => shutdown(0));
}

if (isMain) {
  // Answered before the transport starts, so an install can be checked without a host. Reads the
  // package.json beside this file: the code actually running, not what a manifest pinned.
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(readPackageVersion());
  } else {
    installSignalCleanup(inFlight, { pending: pendingDelegations });
    // One factory serves both protocol eras: a 2025-era initialize pins a legacy instance.
    serveStdio(() => buildServer());
  }
}
