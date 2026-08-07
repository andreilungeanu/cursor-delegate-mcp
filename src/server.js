#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_MODEL, runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION } from "./version.js";
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
export const SERVER_INSTRUCTIONS = `Delegate coding work to Cursor through the delegate tool. Every permission the agent requests is auto-approved, in every mode: mode="plan" and mode="ask" are instructions to the agent, not limits the bridge enforces, and the bridge cannot detect one being ignored. So scope workspace to the smallest relevant directory and review the git diff after every run, not only write-capable ones; filesReportedByEditTools lists what the agent's edit tools reported changing (absent when they reported none) but the diff is authoritative.`;

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
export const doctorAgentShape = {
  found: z.boolean(),
  command: z.string(),
  version: z.string().nullable(),
  error: z.string().optional(),
  handshake: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    protocolVersion: z.unknown().optional(),
    agentCapabilities: z.unknown().optional(),
    models: z.array(z.unknown()).optional(),
    currentModel: z.unknown().optional(),
    modes: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
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
  spec: z.string().trim().min(1, "spec must not be blank").describe("Inline task brief (default): goal, scope, decisions already made (constraints and fixed choices — quote the user's exact values verbatim), acceptance criteria. Point at files to read or mimic rather than pasting code. Optional file path if the user wants a persisted spec."),
  mode: z.enum(["agent", "plan", "ask"]).default("agent").describe("Requested agent mode. plan and ask are passed to the agent as instructions, not enforced by the bridge — the agent may write in any of them, so review the git diff after every run. ask held on every model tested while plan compliance varies by model, so prefer ask when you need the stricter read-only instruction."),
  resumeSessionId: z.string().optional().describe("Resume an existing ACP session instead of a new one"),
  workspace: z.string().optional().describe("Working directory for the agent (defaults to cwd). Must be an existing directory; the call fails rather than creating it."),
  model: z.string().trim().min(1, "model must be a non-empty string").default(DEFAULT_MODEL),
  fast: z.boolean().default(false).describe("Fast speed tier — higher cost; enable only when the user asks"),
  // Which options a model offers, and their valid values, are only knowable by asking the
  // agent, so these stay open strings and the agent rejects what it does not accept.
  reasoning: z.string().trim().min(1).optional().describe("Reasoning effort. Not offered by every model; gpt-5.x accepts none, low, medium, high, extra-high."),
  context: z.string().trim().min(1).optional().describe("Context window size. Not offered by every model; gpt-5.x accepts 272k and 1m."),
  contextFiles: z.array(z.string()).optional().describe("Paths to attach instead of pasting file contents into spec. Text files are passed as references the agent may open; images (png, jpg, gif, webp, under 5MB) are sent inline. Relative paths resolve against workspace, and paths outside it are allowed — attach only files the agent should read. Anything skipped is reported in protocolWarnings, never fatal."),
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
  const { spec, mode, resumeSessionId, workspace, model, fast, reasoning, context, contextFiles } = args;

  const progressToken = extra?._meta?.progressToken;
  /** @type {(message: string) => void} */
  let onProgress = () => {};
  if (progressToken != null) {
    let progress = 0;
    onProgress = (message) => {
      try {
        extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++progress, message },
        });
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
      workspace: workspace || process.cwd(),
      model,
      fast,
      reasoning,
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
        `Delegate a coding task to cursor-agent over ACP. Never shell out to cursor-agent — use this tool only. Pass structured task text inline in spec (default); a file path is optional when the user wants a persisted brief. Defaults: mode=agent, model=${DEFAULT_MODEL}, fast=false. Plan workflow: mode=plan, then resume with mode=agent and resumeSessionId. Auto-approves every permission the agent requests, in any mode and anywhere on disk. Clarifying questions arrive as prose in result — resume with resumeSessionId to answer. Returns the final result, selection source, stop reason, session ID, agent-reported files, and optional plan. See the delegate skill for orchestration.`,
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
        "Best-effort cancel of an in-flight ACP delegation by sessionId. Sends session/cancel; the agent may finish the turn anyway. The delegate result carries cancelRequested: true when the turn was cancelled mid-run. MCP hosts that serialize tool calls cannot run this while delegate is in flight. With force: true, the agent process is killed if the turn is still running after a short grace period. Returns not-running for a session whose turn already ended (it is still resumable), and not-found for an id never seen this process.",
      inputSchema: {
        sessionId: z.string(),
        force: z.boolean().default(false).describe("After the cancel notify, wait a short grace period and kill the agent process if the delegation is still running"),
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
      for (const handle of stillRunning) handle.client.stop();
      inFlight.delete(sessionId);
      return cancelResult("killed", sessionId);
    }
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Report setup and health diagnostics: plugin version, MCP client capabilities, cursor-agent launcher resolution, and optional deep ACP handshake. Use when delegation fails or agent.found is false.",
      inputSchema: {
        deep: z
          .boolean()
          .default(false)
          .describe("When true, run a lightweight ACP handshake (start → initialize → newSession) to verify the agent is usable"),
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

if (isMain) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
