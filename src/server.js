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

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`cursor-delegate-mcp requires Node 22+ (found ${process.versions.node})`);
  process.exit(1);
}

const inFlight = new Map();

// Loaded at connect, before any tool schema is, so this carries only pre-call facts: what a
// caller needs to decide whether to delegate at all. Call-time facts belong on the parameter
// descriptions, read while the call is being written.
export const SERVER_INSTRUCTIONS = `Delegate coding work to Cursor through the delegate tool. Every permission the agent requests is auto-approved, in every mode: mode="plan" and mode="ask" are instructions to the agent, not limits the bridge enforces, and the bridge cannot detect one being ignored. So scope workspace to the smallest relevant directory and review the git diff after every run, not only write-capable ones; filesReportedByAgent lists what the agent reported editing but the diff is authoritative.`;

const planEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
}).passthrough();

const delegateOutputSchema = z.object({
  result: z.string(),
  resultSource: z.enum(["tool-free-stream", "post-tool", "pre-tool-fallback", "none"]).optional().describe(
    "Where result came from. pre-tool-fallback means no final message closed the turn and result is the last message before the agent's final tool call — read protocolWarnings before trusting it as the answer."
  ),
  finalMessageAvailable: z.boolean().optional(),
  stopReason: z.string().optional().describe(
    "Present only when it is not the ordinary end_turn — a refusal, a cancel, or an output cap. Absence means the turn ended normally."
  ),
  sessionId: z.string(),
  filesReportedByAgent: z.array(z.string()).describe(
    "Files the agent reported editing via native ACP diff events (may omit shell-driven edits)."
  ),
  questionsAsked: z.array(z.string()).optional(),
  resumed: z.boolean().optional(),
  sessionTitle: z.string().optional().describe(
    "Short title the agent gave this turn. Present on most turns; purely a label."
  ),
  autoAnswered: z.array(z.object({ prompt: z.string(), chosen: z.string() })).optional(),
  fallbackAnswers: z.array(z.object({ prompt: z.string(), given: z.string(), chosen: z.string() })).optional(),
  cancelRequested: z.boolean().optional(),
  protocolWarnings: z.array(z.string()).optional().describe(
    "Non-fatal diagnostics that did not justify failing the call — dropped or sanitized ACP fields, a failed resume, ignored model options, skipped contextFiles, a mid-session mode switch. Read whenever present."
  ),
  plan: z.object({
    entries: z.array(planEntrySchema),
    overview: z.string().optional(),
    detail: z.string().optional(),
  }).optional(),
  todos: z.array(z.object({
    id: z.string(),
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
  })).optional().describe(
    "Todo list the agent tracked for this turn. Absent when the agent tracked none, which is common on short tasks and does not imply incompleteness."
  ),
  modeChanged: z.object({ from: z.string(), to: z.string() }).optional().describe(
    "Set when the agent switched itself out of the requested mode mid-session. Absence does not mean the mode was honored — an agent can write while staying in plan."
  ),
  writeCapableActivity: z.array(z.object({ kind: z.string(), detail: z.string(), path: z.string().optional() })).optional().describe(
    "Write-capable tool calls (edit/delete/move/execute) the agent ran during a plan or ask turn, which are expected to change nothing. Records what ran, not what changed — a shell command is not a change list. Only populated for mode plan and ask."
  ),
  todoProgress: z.object({
    total: z.number(),
    completed: z.number(),
    inProgress: z.number(),
    pending: z.number(),
  }).optional(),
}).passthrough();

const doctorOutputSchema = z.object({
  plugin: z.object({ version: z.string() }).passthrough(),
  client: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    capabilities: z.record(z.unknown()),
    supportsElicitation: z.boolean(),
  }).passthrough(),
  agent: z.object({ found: z.boolean() }).passthrough(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    cwd: z.string(),
    transport: z.literal("stdio"),
  }),
  env: z.record(z.unknown()),
}).passthrough();

export const delegateInputSchema = z.object({
  spec: z.string().trim().min(1, "spec must not be blank").describe("Inline task brief (default): goal, scope, decisions already made (constraints and fixed choices — quote the user's exact values verbatim), acceptance criteria. Point at files to read or mimic rather than pasting code. Optional file path if the user wants a persisted spec."),
  mode: z.enum(["agent", "plan", "ask"]).default("agent").describe("Requested agent mode. plan and ask are passed to the agent as instructions, not enforced by the bridge — the agent may write in any of them; modeChanged reports it if it switched."),
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

// A cursor/ask_question question is multi-select when it sets allowMultiple, and the answer
// field (selectedOptionIds) is a list either way. Only split on commas for those, so a
// single-select label that itself contains a comma still matches whole.
function matchOptions(choice, opts = [], allowMultiple = false) {
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const ids = [];
  for (const part of allowMultiple ? String(choice).split(",") : [String(choice)]) {
    const want = norm(part);
    if (!want) continue;
    const hit = opts.find((o) => norm(o.id) === want || norm(o.label) === want);
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

export async function runDelegateTool({ args, extra, server, runDelegate, inFlight }) {
  const { spec, mode, resumeSessionId, workspace, model, fast, reasoning, context, contextFiles } = args;

  const progressToken = extra?._meta?.progressToken;
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

  const supportsElicitation = !!server.server.getClientCapabilities?.()?.elicitation;
  const autoAnswered = [];
  const fallbackAnswers = [];

  const onElicit = async ({ title, questions }) => {
    const answers = [];
    for (const q of questions || []) {
      const opts = q.options || [];
      if (!supportsElicitation) {
        // There is no user to ask, so allowMultiple changes nothing here: selecting every
        // option would consent to more than the caller asked for. Take the first and
        // disclose it. An option-less question answers empty rather than [null].
        const first = opts[0];
        autoAnswered.push({ prompt: String(q.prompt ?? ""), chosen: String(first?.label || first?.id || "") });
        answers.push({ questionId: q.id, selectedOptionIds: first?.id ? [first.id] : [] });
        continue;
      }
      const listing = opts.map((o) => o.label || o.id).join(", ");
      const result = await server.server.elicitInput({
        message: title ? `${title}: ${q.prompt}` : `cursor-agent asks: ${q.prompt}`,
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              description: !opts.length
                ? "your answer"
                : q.allowMultiple
                  ? `Options (pick one or more, comma-separated): ${listing}`
                  : `Options: ${listing}`,
            },
          },
          required: ["choice"],
        },
      });
      if (result.action !== "accept") return null;
      const choice = result.content?.choice || "";
      const selectedOptionIds = matchOptions(choice, opts, q.allowMultiple);
      if (!selectedOptionIds.length && opts.length) {
        selectedOptionIds.push(opts[0].id);
        fallbackAnswers.push({
          prompt: String(q.prompt ?? ""),
          given: String(choice),
          chosen: String(opts[0].label || opts[0].id || ""),
        });
      }
      answers.push({ questionId: q.id, selectedOptionIds });
    }
    return { answers };
  };

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
      onElicit,
      onProgress,
      signal: extra?.signal,
      onSessionReady: (sessionId, client) => {
        capturedSessionId = sessionId;
        handle = { client, cancelRequested: false };
        inFlight.set(sessionId, handle);
      },
    });
    if (autoAnswered.length) out.autoAnswered = autoAnswered;
    if (fallbackAnswers.length) out.fallbackAnswers = fallbackAnswers;
    if (handle?.cancelRequested) out.cancelRequested = true;
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out,
    };
  } catch (err) {
    return {
      // The reason is already decided upstream; naming it here saves the caller parsing
      // prose to tell a timeout from a rejected argument.
      content: [{ type: "text", text: `delegate failed${err?.reason ? ` [${err.reason}]` : ""}: ` + (err?.message || String(err)) }],
      isError: true,
    };
  } finally {
    if (capturedSessionId) inFlight.delete(capturedSessionId);
  }
}

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
        `Delegate a coding task to cursor-agent over ACP. Never shell out to cursor-agent — use this tool only. Pass structured task text inline in spec (default); a file path is optional when the user wants a persisted brief. Defaults: mode=agent, model=${DEFAULT_MODEL}, fast=false. Plan workflow: mode=plan, then resume with mode=agent and resumeSessionId. Auto-approves every permission the agent requests, in any mode and anywhere on disk; uses MCP elicitation for clarifying questions and selects the first option when the client lacks elicitation. Returns the final result, selection source, stop reason, session ID, agent-reported files, and optional plan. See the delegate skill for orchestration.`,
      inputSchema: delegateInputSchema,
      outputSchema: delegateOutputSchema,
      annotations: {
        title: "Delegate coding task to Cursor",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => runDelegateTool({ args, extra, server, runDelegate, inFlight })
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Best-effort cancel of an in-flight ACP delegation by sessionId. Sends session/cancel; the agent may finish the turn anyway. The delegate result carries cancelRequested: true when the turn was cancelled mid-run. MCP hosts that serialize tool calls cannot run this while delegate is in flight. With force: true, the agent process is killed if the turn is still running after a short grace period.",
      inputSchema: {
        sessionId: z.string(),
        force: z.boolean().default(false).describe("After the cancel notify, wait a short grace period and kill the agent process if the delegation is still running"),
      },
      outputSchema: z.object({ status: z.enum(["cancelled", "killed", "not-found"]), sessionId: z.string() }),
      annotations: {
        title: "Cancel Cursor delegation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, force }) => {
      const handle = inFlight.get(sessionId);
      if (!handle) {
        return {
          content: [{ type: "text", text: `no in-flight session ${sessionId}` }],
          structuredContent: { status: "not-found", sessionId },
        };
      }
      handle.cancelRequested = true;
      await handle.client.cancel(sessionId).catch(() => {});
      if (!force) {
        // The handle stays registered: session/cancel is best-effort, so the turn may still
        // be running. Dropping it here made the natural escalation — cancel, wait, cancel
        // with force — report not-found while the agent was alive. The delegation's own
        // finally removes the entry when the turn actually settles.
        return {
          content: [{ type: "text", text: `cancelled ${sessionId}` }],
          structuredContent: { status: "cancelled", sessionId },
        };
      }
      await new Promise((r) => setTimeout(r, forceGraceMs));
      if (!inFlight.has(sessionId)) {
        return {
          content: [{ type: "text", text: `cancelled ${sessionId}` }],
          structuredContent: { status: "cancelled", sessionId },
        };
      }
      handle.client.stop();
      inFlight.delete(sessionId);
      return {
        content: [{ type: "text", text: `killed ${sessionId}` }],
        structuredContent: { status: "killed", sessionId },
      };
    }
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Report setup and health diagnostics: plugin version, MCP client capabilities (including elicitation support), cursor-agent launcher resolution, and optional deep ACP handshake. Use when delegation fails or agent.found is false.",
      inputSchema: {
        deep: z
          .boolean()
          .default(false)
          .describe("When true, run a lightweight ACP handshake (start → initialize → newSession) to verify the agent is usable"),
      },
      outputSchema: doctorOutputSchema,
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
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
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
