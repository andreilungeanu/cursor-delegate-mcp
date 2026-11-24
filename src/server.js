#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { DEFAULT_MODEL, runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION, readPackageVersion } from "./version.js";
import { children } from "./proc.js";
import { installSignalCleanup } from "./shutdown.js";
import { PLAN_PRIORITIES, PLAN_STATUSES, TODO_STATUSES } from "./acp-enums.js";
import { TASKS_EXTENSION, createTaskStore, listsTasks, registerTaskHandlers, runAsTask } from "./tasks.js";

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
// Session ids seen by this process, kept after the turn ends so cancel can tell a finished
// (still resumable) session from an id that never existed.
const seenSessions = new Set();

// Delegations answered as MCP tasks. Module-level, as inFlight: a task outlives the request that
// started it, and serveStdio may build more than one server instance.
const taskStore = createTaskStore();

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
  resumeSessionId: z.string().optional().describe("Continue an existing ACP session. When delegate ran as an MCP task, its server-side task id works too."),
  workspace: z.string().trim().min(1, "workspace must not be blank").describe("The agent's working directory, not a limit. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call."),
  model: z.string().trim().min(1, "model must be a non-empty string").default(DEFAULT_MODEL).describe(`Bare ACP family id, version included, such as ${DEFAULT_MODEL}. The ids on offer depend on the account; doctor deep:true lists them.`),
  fast: z.boolean().default(false).describe("Fast tier; higher cost — only when the user asks."),
  // Open string: a model's values are known only once it is selected, then validated live.
  effort: z.string().trim().min(1).optional().describe("Exact Cursor thinking-effort value for the selected model. Values differ per model and some expose no effort option; invalid values fail before the prompt and name the accepted set. Pass only when the user asks for Cursor effort — the host's own reasoning setting is unrelated."),
  context: z.string().trim().min(1).optional().describe("Context window size; gpt-5.x accepts 272k and 1m. Do not pass speculatively."),
  contextFiles: z.array(z.string()).optional().describe("Paths to attach instead of pasting contents into spec. Text becomes references the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against workspace but are not limited to it. Skips are reported in protocolWarnings, never fatal."),
});

/** @returns {(message: string) => void} */
export function progressNotifier(ctx) {
  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  if (progressToken == null) return () => {};
  let progress = 0;
  return (message) => {
    // An unhandled rejection from notify would exit the server; the try catches a sync throw.
    try {
      Promise.resolve(ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress, message },
      })).catch(() => {});
    } catch {}
  };
}

/**
 * @param {{
 *   args: any, ctx?: any,
 *   runDelegate: (opts: any) => Promise<any>,
 *   inFlight: Map<string, Set<any>>,
 *   seenSessions?: Set<string>,
 *   signal?: AbortSignal,
 *   onProgress?: (message: string) => void,
 *   onPromptSent?: (sessionId: string, handle: any, resumeNote?: string) => void,
 *   onUnseenExit?: (note: string) => void,
 *   onTurnEnd?: () => void,
 * }} deps
 * @returns {Promise<import("@modelcontextprotocol/server").CallToolResult>}
 */
export async function runDelegateTool({
  args, ctx, runDelegate, inFlight, seenSessions = new Set(),
  signal = ctx?.mcpReq?.signal, onProgress = progressNotifier(ctx), onPromptSent, onUnseenExit, onTurnEnd,
}) {
  const { spec, mode, resumeSessionId, workspace, model, fast, effort, context, contextFiles } = args;

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
      signal,
      onPromptSent: onPromptSent && ((sessionId, resumeNote) => onPromptSent(sessionId, handle, resumeNote)),
      onUnseenExit,
      onSessionReady: (sessionId, client) => {
        capturedSessionId = sessionId;
        handle = { client, cancelRequested: false };
        registerInFlight(inFlight, sessionId, handle);
        seenSessions.add(sessionId);
        // Sent now so a host that can call tools concurrently has an id to cancel mid-run.
        onProgress(`session ready: ${sessionId}`);
      },
      onTurnEnd: () => {
        if (handle) handle.ended = true;
        onTurnEnd?.();
      },
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
    // Drops only this delegation's handle; the id stays registered while another turn runs on it.
    if (capturedSessionId) unregisterInFlight(inFlight, capturedSessionId, handle);
  }
}

/**
 * @param {{
 *   runDelegate?: (opts: any) => Promise<any>,
 *   runDoctor?: (opts: any) => Promise<any>,
 *   forceGraceMs?: number,
 *   inFlight?: Map<string, Set<any>>,
 *   era?: "legacy" | "modern",
 *   tasks?: ReturnType<typeof createTaskStore>,
 * }} [opts]
 */
export function buildServer({
  runDelegate: runDelegateInjected, runDoctor: runDoctorInjected, forceGraceMs = 5000,
  inFlight: flights = inFlight, era, tasks = taskStore,
} = {}) {
  const runDelegate = runDelegateInjected || runDelegateDefault;
  const runDoctor = runDoctorInjected || runDoctorDefault;
  // Tasks only on a 2026-07-28 instance: the SDK also lifts envelope keys off 2025-era requests.
  const servesTasks = era === "modern";
  const server = new McpServer(
    { name: "cursor-delegate-mcp", version: VERSION, icons: SERVER_ICONS },
    {
      instructions: SERVER_INSTRUCTIONS,
      ...(servesTasks ? { capabilities: { extensions: { [TASKS_EXTENSION]: {} } } } : {}),
    }
  );
  if (servesTasks) registerTaskHandlers(server, tasks);
  // A task id names its own run, which a later turn on the same session is not; a session id names
  // every turn running on it.
  /** @param {string} id */
  const targetOf = (id) => {
    const task = tasks.get(id);
    if (!task?.sessionId) return { sessionId: id, handles: flights.get(id) };
    const running = task.status === "working" && flights.get(task.sessionId)?.has(task.handle);
    return { sessionId: task.sessionId, handles: new Set(running ? [task.handle] : []) };
  };

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
    async (args, ctx) => {
      // Claude Code tells the model a task's id and never its session id, even after a stop.
      const resumeSessionId = tasks.sessionOf(args.resumeSessionId) ?? args.resumeSessionId;
      /** @param {Record<string, any>} [over] */
      const run = (over) => runDelegateTool({ args: { ...args, resumeSessionId }, ctx, runDelegate, inFlight: flights, seenSessions, ...over });
      if (!servesTasks || !listsTasks(ctx)) return run();
      return /** @type {any} */ (runAsTask({ run, signal: ctx?.mcpReq?.signal, notify: progressNotifier(ctx), store: tasks }));
    }
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Best-effort cancel of an in-flight delegation by sessionId. session/cancel is advisory — the agent may finish the turn anyway, and the delegate result then carries cancelRequested. Status: cancelled, killed (agent process observed to exit), not-running (turn already ended, still resumable), not-found (id not in this process's session history).",
      inputSchema: z.object({
        // Blank is a malformed call, not a stale id.
        sessionId: z.string().trim().min(1, "sessionId must not be blank").describe("When delegate runs as an MCP task, its server-side task id works too."),
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
    async ({ sessionId: id, force }) => {
      const { sessionId, handles } = targetOf(id);
      if (!handles || handles.size === 0) {
        // A finished session is still resumable; only an unknown id is not-found.
        const known = seenSessions.has(sessionId);
        return cancelResult(known ? "not-running" : "not-found", sessionId);
      }
      // Every turn the id names, taken now: a resume that registers during the grace or the kill is
      // not swept in. An ended turn stays registered while its agent is stopped; its result is
      // decided, so a cancel leaves it alone.
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
      const running = () => targeted.filter((handle) => !handle.ended && flights.get(sessionId)?.has(handle));
      const graceEnds = Date.now() + forceGraceMs;
      while (Date.now() < graceEnds && running().length) {
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, graceEnds - Date.now()))));
      }
      const toKill = running();
      if (toKill.length === 0) return cancelResult("cancelled", sessionId);
      const observed = await Promise.all(
        toKill.map((handle) => Promise.resolve(handle.client.stop()).catch(() => false))
      );
      // "killed" needs an observed exit.
      if (!observed.every(Boolean)) return cancelResult("cancelled", sessionId);
      for (const handle of toKill) unregisterInFlight(flights, sessionId, handle);
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
      const out = await runDoctor({ deep, signal: ctx?.mcpReq?.signal, getClientInfo: () => clientInfoOf(server, ctx) });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
  );

  return server;
}

// A 2025-era client sends its identity once, in initialize, which stays authoritative on that
// connection even if a request carries envelope keys; a 2026-07-28 one sends it with each request.
export function clientInfoOf(server, ctx) {
  const envelope = ctx?.mcpReq?.envelope;
  return {
    capabilities: server.server.getClientCapabilities() ?? envelope?.[CLIENT_CAPABILITIES_META_KEY],
    version: server.server.getClientVersion() ?? envelope?.[CLIENT_INFO_META_KEY],
    protocolVersion: server.server.getNegotiatedProtocolVersion() ?? envelope?.[PROTOCOL_VERSION_META_KEY],
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

if (isMain) {
  // Answered before the transport starts, so an install can be checked without a host. Reads the
  // package.json beside this file: the code actually running, not what a manifest pinned.
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(readPackageVersion());
  } else {
    const hostGone = installSignalCleanup(() => children.stopAll());
    const transport = new StdioServerTransport();
    // One factory serves both protocol eras: a 2025-era initialize pins a legacy instance, and only
    // a modern one answers with tasks.
    serveStdio(({ era }) => buildServer({ era }), { transport });
    // The transport also closes on a broken stdout, and then pauses stdin, so no 'end' arrives.
    const closeServers = transport.onclose;
    transport.onclose = () => {
      closeServers?.();
      hostGone();
    };
  }
}
