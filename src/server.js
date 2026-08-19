#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_MODEL, runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION, readPackageVersion } from "./version.js";
import { DETACHED } from "./proc.js";
import { PLAN_PRIORITIES, PLAN_STATUSES, TODO_STATUSES } from "./acp-enums.js";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`cursor-delegate-mcp requires Node 20+ (found ${process.versions.node})`);
  process.exit(1);
}

// sessionId -> the set of delegations currently running on it. A set, not a single handle,
// because a resume can race the turn it resumes: both are live, both are cancellable, and
// keying one handle per id let whichever finished first deregister the other — after which
// cancel reported a running session as already ended.
const inFlight = new Map();
function registerInFlight(map, sessionId, handle) {
  const handles = map.get(sessionId);
  if (handles) handles.add(handle);
  else map.set(sessionId, new Set([handle]));
}
/** @returns {import("@modelcontextprotocol/sdk/types.js").CallToolResult} */
function cancelResult(status, sessionId) {
  return { content: [{ type: "text", text: JSON.stringify({ status, sessionId }) }] };
}
function unregisterInFlight(map, sessionId, handle) {
  const handles = map.get(sessionId);
  if (!handles) return;
  handles.delete(handle);
  if (handles.size === 0) map.delete(sessionId);
}
// Session ids seen this process, kept after the turn ends so cancel can tell a finished
// session (resumable, only the turn is over) from an id that never existed. Bounded so a
// long-lived server does not grow without limit.
const seenSessions = new Set();
const SEEN_SESSIONS_CAP = 500;
function rememberSession(set, id) {
  if (id == null || set.has(id)) return;
  set.add(id);
  if (set.size > SEEN_SESSIONS_CAP) set.delete(set.values().next().value);
}

// Loaded at connect, before any tool schema is, so this carries only pre-call facts: what a
// caller needs to decide whether to delegate at all. Call-time facts belong on the parameter
// descriptions, read while the call is being written.
export const SERVER_INSTRUCTIONS = `Delegate coding work to Cursor through the delegate tool. Every permission the agent requests is auto-approved, in every mode: agent/plan/ask reach any file the user account can, and mode instructs the agent rather than limiting it. Scope workspace tightly and review the git diff after every run — filesReportedByEditTools carries only what the agent's edit tools reported; the diff is authoritative.`;

const planEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(PLAN_PRIORITIES).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
}).passthrough();

// No tool declares an outputSchema: declaring one obliges the server to also return
// structuredContent, and a host that reads both it and the text block — Codex does — puts the
// payload in the model's context twice. Every tool returns one compact JSON text block instead.
// So this is an in-repo contract, enforced by the .strict() copy in delegate.test.js, which
// fails when a field added in delegate.js is forgotten here. cancel's status vocabulary is
// published in its tool description, which is now its only schema.
//
// Types only. What each field means, and what its absence means, is documented once in
// skills/delegate/reference.md.
export const delegateOutputShape = {
  result: z.string(),
  resultSource: z.enum(["pre-tool-fallback", "none"]).optional(),
  effectiveModel: z.string().optional(),
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
  }).optional(),
};

// What doctor reports about the launcher — the same in-repo contract as delegateOutputShape.
//
// Fields this bridge computes are typed; fields relayed verbatim from the agent are left unknown
// on purpose. doctor runs when the agent is already misbehaving, so a schema tight enough to
// reject a weird protocolVersion would fail on the agent's output rather than on ours.
// doctor.test.js parses every result against a strict copy of this shape.
//
// Types only; what the fields mean is documented once, in TECHNICAL.md.
// Split out so the drift guard can make it strict on its own: a .strict() on agent does not look
// inside handshake, which is the level this schema has drifted at twice.
export const doctorHandshakeShape = {
  ok: z.boolean(),
  error: z.string().optional(),
  protocolVersion: z.unknown().optional(),
  agentCapabilities: z.unknown().optional(),
  models: z.array(z.unknown()).optional(),
  currentModel: z.unknown().optional(),
  modes: z.array(z.unknown()).optional(),
  // Built here rather than relayed, so it gets a real type where its neighbours get z.unknown().
  currentModelOptions: z.array(z.object({ id: z.string(), values: z.array(z.string()) })).optional(),
};

export const doctorAgentShape = {
  found: z.boolean(),
  command: z.string(),
  version: z.string().nullable(),
  error: z.string().optional(),
  handshake: z.object(doctorHandshakeShape).passthrough().optional(),
};

// Exported as a shape for the same reason as delegateOutputShape, and with agent split out
// because a top-level .strict() does not look inside a nested object — which is exactly where
// this schema drifted.
export const doctorOutputShape = {
  plugin: z.object({ version: z.string() }).passthrough(),
  client: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    capabilities: z.record(z.unknown()),
  }).passthrough(),
  agent: z.object(doctorAgentShape).passthrough(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    cwd: z.string(),
    transport: z.literal("stdio"),
  }),
  env: z.record(z.unknown()),
};

export const delegateInputSchema = z.object({
  spec: z.string().trim().min(1, "spec must not be blank").describe("Task brief: goal, scope, fixed decisions quoted exactly, acceptance criteria. Sent as written. Point at files to read rather than pasting code, or attach them with contextFiles."),
  mode: z.enum(["agent", "plan", "ask"]).default("agent").describe("agent implements; plan and ask are instructions to the agent, not limits."),
  resumeSessionId: z.string().optional().describe("Continue an existing ACP session."),
  workspace: z.string().trim().min(1, "workspace must not be blank").describe("The agent's working directory, not a limit. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call."),
  model: z.string().trim().min(1, "model must be a non-empty string").default(DEFAULT_MODEL).describe("Bare ACP family id, version included: composer-2.5, grok-4.5, claude-opus-5, gpt-5.6-sol. doctor deep:true lists every id."),
  fast: z.boolean().default(false).describe("Fast tier; higher cost — only when the user asks."),
  // Which values a model offers is only knowable after selecting it, so this stays an open
  // string and the bridge validates the exact token against the live option list.
  effort: z.string().trim().min(1).optional().describe("Exact Cursor thinking-effort value for the selected model. Values differ per model and some expose no effort option; invalid values fail before the prompt and name the accepted set. Pass only when the user asks for Cursor effort — the host's own reasoning setting is unrelated."),
  context: z.string().trim().min(1).optional().describe("Context window size; gpt-5.x accepts 272k and 1m. Do not pass speculatively."),
  contextFiles: z.array(z.string()).optional().describe("Paths to attach instead of pasting contents into spec. Text becomes references the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against workspace but are not limited to it. Skips are reported in protocolWarnings, never fatal."),
});

/**
 * @param {{
 *   args: any, extra?: any,
 *   runDelegate: (opts: any) => Promise<any>,
 *   inFlight: Map<string, Set<any>>,
 *   seenSessions?: Set<string>,
 * }} deps
 * @returns {Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>}
 */
export async function runDelegateTool({ args, extra, runDelegate, inFlight, seenSessions = new Set() }) {
  const { spec, mode, resumeSessionId, workspace, model, fast, effort, context, contextFiles } = args;

  const progressToken = extra?._meta?.progressToken;
  /** @type {(message: string) => void} */
  let onProgress = () => {};
  if (progressToken != null) {
    let progress = 0;
    onProgress = (message) => {
      // sendNotification is async: its rejection settles outside this try and would exit the
      // server. The try stays for a sync throw, which lands before Promise.resolve can wrap it.
      try {
        Promise.resolve(extra.sendNotification({
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
      signal: extra?.signal,
      onSessionReady: (sessionId, client) => {
        capturedSessionId = sessionId;
        handle = { client, cancelRequested: false };
        registerInFlight(inFlight, sessionId, handle);
        rememberSession(seenSessions, sessionId);
        // Emit the id the moment the session opens, before the turn finishes, so a host that
        // can call tools concurrently has something to pass to cancel mid-run — otherwise the
        // id only arrives when delegate returns, by which point there is nothing to cancel.
        // (Hosts that serialize tool calls still cannot cancel in flight; that is a host limit.)
        onProgress(`session ready: ${sessionId}`);
      },
    });
    if (handle?.cancelRequested) out.cancelRequested = true;
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  } catch (err) {
    return {
      // The reason is already decided upstream; naming it here saves the caller parsing
      // prose to tell a timeout from a rejected argument.
      content: [{ type: "text", text: `delegate failed${err?.reason ? ` [${err.reason}]` : ""}: ` + (err?.message || String(err)) }],
      isError: true,
    };
  } finally {
    // Drops only this delegation's own handle; the id stays registered while another turn
    // is still running on it.
    if (capturedSessionId) unregisterInFlight(inFlight, capturedSessionId, handle);
  }
}

/**
 * @param {{
 *   runDelegate?: (opts: any) => Promise<any>,
 *   runDoctor?: (opts: any) => Promise<any>,
 *   forceGraceMs?: number,
 * }} [opts]
 */
export function buildServer({ runDelegate: runDelegateInjected, runDoctor: runDoctorInjected, forceGraceMs = 5000 } = {}) {
  const runDelegate = runDelegateInjected || runDelegateDefault;
  const runDoctor = runDoctorInjected || runDoctorDefault;
  const server = new McpServer(
    { name: "cursor-delegate-mcp", version: VERSION },
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
    async (args, extra) => runDelegateTool({ args, extra, runDelegate, inFlight, seenSessions })
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Best-effort cancel of an in-flight delegation by sessionId. session/cancel is advisory — the agent may finish the turn anyway, and the delegate result then carries cancelRequested. Status: cancelled, killed (agent process observed to exit), not-running (turn already ended, still resumable), not-found (id not in this process's recent session history).",
      inputSchema: {
        sessionId: z.string(),
        force: z.boolean().default(false).describe("Kill the agent process if the turn is still running after a short grace period."),
      },
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
        // A finished session and a garbage id are both "not in flight". Reporting them alike
        // would read as "bad id" for a session that ran and is still resumable.
        const known = seenSessions.has(sessionId);
        return cancelResult(known ? "not-running" : "not-found", sessionId);
      }
      // Cancel every turn running on the id: the caller named a session, not one of the
      // turns that happen to share it.
      for (const handle of handles) handle.cancelRequested = true;
      await Promise.all([...handles].map((handle) => handle.client.cancel(sessionId).catch(() => {})));
      if (!force) {
        // The handles stay registered: session/cancel is best-effort, so the turn may still
        // be running. Dropping them here made the natural escalation — cancel, wait, cancel
        // with force — report not-found while the agent was alive. Each delegation's own
        // finally removes its handle when the turn actually settles.
        return cancelResult("cancelled", sessionId);
      }
      await new Promise((r) => setTimeout(r, forceGraceMs));
      const stillRunning = inFlight.get(sessionId);
      if (!stillRunning || stillRunning.size === 0) return cancelResult("cancelled", sessionId);
      const observed = await Promise.all(
        [...stillRunning].map((handle) => Promise.resolve(handle.client.stop()).catch(() => false))
      );
      // "killed" claims the process is gone, so it needs the exit, not just a dispatched signal.
      // When one does not follow, the handles stay registered and force can be tried again.
      if (!observed.every(Boolean)) return cancelResult("cancelled", sessionId);
      inFlight.delete(sessionId);
      return cancelResult("killed", sessionId);
    }
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Setup diagnostics: plugin version, MCP client capabilities, cursor-agent launcher resolution. Run when delegation fails or agent.found is false.",
      inputSchema: {
        deep: z
          .boolean()
          .default(false)
          .describe("Run an ACP handshake (start → initialize → newSession) to verify the agent is usable; adds models, modes and the current model's options."),
      },
      annotations: {
        title: "Diagnose Cursor delegation setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deep }) => {
      const out = await runDoctor({
        deep,
        getClientInfo: () => ({
          capabilities: server.server.getClientCapabilities(),
          version: server.server.getClientVersion(),
        }),
      });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
  );

  return server;
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
export function installSignalCleanup(map, { exit = (code) => process.exit(code), stdin = process.stdin } = {}) {
  let shuttingDown = false;
  const shutdown = (code) => {
    // A second trigger skips the wait below: the kills are already dispatched, and a caller
    // that has asked twice wants out now.
    if (shuttingDown) return exit(code);
    shuttingDown = true;
    const stops = [];
    for (const handles of map.values()) {
      for (const handle of handles) {
        try { stops.push(Promise.resolve(handle.client.stop()).catch(() => {})); } catch {}
      }
    }
    // On Windows the kill is a separate taskkill process: exiting before it walks the tree
    // orphans everything below the shell wrapper — the ps1 launcher and the versioned agent
    // were measured surviving the server's exit. stop() bounds itself (observed exit or its
    // own deadline), so this wait is short and finite on every platform.
    Promise.all(stops).then(() => exit(code), () => exit(code));
  };
  // Each agent runs in its own process group on POSIX, so a signal aimed at this process no
  // longer reaches it the way it did when the two shared a group. Installing a handler replaces
  // Node's default, and a server that swallows Ctrl-C would be a worse bug than the agent it
  // leaks. Delegations still in their handshake are not in the map yet, so this covers the turn,
  // not the first few seconds of it.
  if (DETACHED) {
    const signals = /** @type {[NodeJS.Signals, number][]} */ ([["SIGINT", 130], ["SIGTERM", 143]]);
    for (const [signal, code] of signals) process.on(signal, () => shutdown(code));
  }
  // Closing the server's stdin is how a stdio host shuts the transport down, and it is what a
  // host reaches for before it resorts to a signal. The SDK transport does not listen for it —
  // it subscribes to `data` and `error` only — so EOF leaves this process up with a delegation
  // still running and nobody left to hand it to.
  stdin.on("end", () => shutdown(0));
}

if (isMain) {
  // Without this the flag falls through to the transport, which owns stdout and waits on stdin —
  // so confirming an install meant wiring the server into a host first. Reads the package.json
  // beside this file, so it reports the code that is actually running rather than what a
  // manifest pinned. stdout is free here because the transport never starts.
  if (process.argv.slice(2).includes("--version")) {
    console.log(readPackageVersion());
  } else {
    const server = buildServer();
    installSignalCleanup(inFlight);
    await server.connect(new StdioServerTransport());
  }
}
