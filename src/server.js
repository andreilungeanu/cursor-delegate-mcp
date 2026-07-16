#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION } from "./version.js";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`cursor-delegate-mcp requires Node 22+ (found ${process.versions.node})`);
  process.exit(1);
}

const inFlight = new Map();

export const SERVER_INSTRUCTIONS = `Delegate coding work to Cursor through the delegate tool. The delegate tool can create, modify, or delete files in its workspace, so scope workspace to the smallest relevant directory and review touchedFiles plus the git diff after every write-capable run. For approval-gated work, call delegate with mode="plan", review the returned plan and sessionId, then resume with mode="agent" and resumeSessionId. Use mode="ask" for read-only questions and doctor for setup diagnostics.`;

const planEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
}).passthrough();

const delegateOutputSchema = z.object({
  result: z.string(),
  resultSource: z.enum(["tool-free-stream", "post-tool", "none"]).optional(),
  finalMessageAvailable: z.boolean().optional(),
  stopReason: z.string().optional(),
  sessionId: z.string(),
  touchedFiles: z.array(z.string()),
  touchedFilesSource: z.enum(["git", "diff-only"]).optional(),
  questionsAsked: z.array(z.string()).optional(),
  resumed: z.boolean().optional(),
  autoAnswered: z.array(z.object({ prompt: z.string(), chosen: z.string() })).optional(),
  fallbackAnswers: z.array(z.object({ prompt: z.string(), given: z.string(), chosen: z.string() })).optional(),
  cancelRequested: z.boolean().optional(),
  protocolWarnings: z.array(z.string()).optional(),
  plan: z.object({
    entries: z.array(planEntrySchema),
    overview: z.string().optional(),
    detail: z.string().optional(),
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

export async function runDelegateTool({ args, extra, server, runDelegate, inFlight }) {
  const { spec, mode, resumeSessionId, workspace, model, fast } = args;

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
        const chosenOptionId = opts[0]?.id;
        const chosen = opts.find((o) => o.id === chosenOptionId)?.label || chosenOptionId || "";
        autoAnswered.push({ prompt: String(q.prompt ?? ""), chosen: String(chosen) });
        answers.push({ questionId: q.id, selectedOptionIds: [chosenOptionId] });
        continue;
      }
      const result = await server.server.elicitInput({
        message: title ? `${title}: ${q.prompt}` : `cursor-agent asks: ${q.prompt}`,
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              description: opts.length ? `Options: ${opts.map((o) => o.label || o.id).join(", ")}` : "your answer",
            },
          },
          required: ["choice"],
        },
      });
      if (result.action !== "accept") return null;
      const choice = result.content?.choice || "";
      let chosenOptionId = opts[0]?.id;
      let matched = false;
      for (const o of opts) {
        if (
          choice.toLowerCase() === String(o.id || "").toLowerCase() ||
          choice.toLowerCase() === String(o.label || "").toLowerCase()
        ) {
          chosenOptionId = o.id;
          matched = true;
          break;
        }
      }
      if (!matched && opts.length) {
        const chosen = opts.find((o) => o.id === chosenOptionId)?.label || chosenOptionId || "";
        fallbackAnswers.push({ prompt: String(q.prompt ?? ""), given: String(choice), chosen: String(chosen) });
      }
      answers.push({ questionId: q.id, selectedOptionIds: [chosenOptionId] });
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
      content: [{ type: "text", text: "delegate failed: " + (err?.message || String(err)) }],
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
        "Delegate a coding task to cursor-agent over ACP. Never shell out to cursor-agent — use this tool only. Pass structured task text inline in spec (default); a file path is optional when the user wants a persisted brief. Defaults: mode=agent, model=composer-2.5, fast=false. Plan workflow: mode=plan, then resume with mode=agent and resumeSessionId. Auto-approves writes in workspace; uses MCP elicitation for clarifying questions and selects the first option when the client lacks elicitation. Returns the final result, selection source, stop reason, session ID, changed files, and optional plan. See the delegate skill for orchestration.",
      inputSchema: {
        spec: z.string().describe("Inline task brief (default): goal, scope, decisions already made (constraints and fixed choices — quote the user's exact values verbatim), acceptance criteria. Point at files to read or mimic rather than pasting code. Optional file path if the user wants a persisted spec."),
        mode: z.enum(["agent", "plan", "ask"]).default("agent"),
        resumeSessionId: z.string().optional().describe("Resume an existing ACP session instead of a new one"),
        workspace: z.string().optional().describe("Working directory for the agent (defaults to cwd)"),
        model: z.string().trim().min(1, "model must be a non-empty string").default("composer-2.5"),
        fast: z.boolean().default(false).describe("Fast speed tier — higher cost; enable only when the user asks"),
      },
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
        inFlight.delete(sessionId);
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
