#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runDelegate as runDelegateDefault } from "./delegate.js";
import { runDoctor as runDoctorDefault } from "./doctor.js";
import { VERSION } from "./version.js";

const inFlight = new Map();

export async function runDelegateTool({ args, extra, server, runDelegate, inFlight }) {
  const { spec, mode, resumeSessionId, workspace, model, fast } = args;

  const progressToken = extra?._meta?.progressToken;
  let onProgress = () => {};
  if (progressToken != null) {
    let progress = 0;
    let lastSent = 0;
    onProgress = (message) => {
      const now = Date.now();
      if (progress > 0 && now - lastSent < 100) return;
      lastSent = now;
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
        autoAnswered.push({ prompt: q.prompt, chosen });
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
        fallbackAnswers.push({ prompt: q.prompt, given: choice, chosen });
      }
      answers.push({ questionId: q.id, selectedOptionIds: [chosenOptionId] });
    }
    return { answers };
  };

  let capturedSessionId;
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
      onSessionReady: (sessionId, client) => {
        capturedSessionId = sessionId;
        inFlight.set(sessionId, client);
      },
    });
    if (autoAnswered.length) out.autoAnswered = autoAnswered;
    if (fallbackAnswers.length) out.fallbackAnswers = fallbackAnswers;
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

export function buildServer({ runDelegate: runDelegateInjected, runDoctor: runDoctorInjected } = {}) {
  const runDelegate = runDelegateInjected || runDelegateDefault;
  const runDoctor = runDoctorInjected || runDoctorDefault;
  const server = new McpServer({ name: "cursor-delegate-mcp", version: VERSION });

  server.registerTool(
    "delegate",
    {
      description:
        "Delegate a coding task to cursor-agent over ACP. Never shell out to cursor-agent — use this tool only. Pass structured task text inline in spec (default); a file path is optional when the user wants a persisted brief. Defaults: mode=agent, model=composer-2.5, fast=false. Plan workflow: mode=plan, then resume with mode=agent and resumeSessionId. Auto-approves writes in workspace; surfaces clarifying questions via elicitation. Returns result, stopReason, sessionId, touchedFiles, and plan (in plan mode). See plugin delegate skill for orchestration.",
      inputSchema: {
        spec: z.string().describe("Inline task brief (default): goal, scope, acceptance criteria. Optional file path if the user wants a persisted spec."),
        mode: z.enum(["agent", "plan", "ask"]).default("agent"),
        resumeSessionId: z.string().optional().describe("Resume an existing ACP session instead of a new one"),
        workspace: z.string().optional().describe("Working directory for the agent (defaults to cwd)"),
        model: z.string().default("composer-2.5"),
        fast: z.boolean().default(false).describe("Fast speed tier — higher cost; enable only when the user asks"),
      },
    },
    async (args, extra) => runDelegateTool({ args, extra, server, runDelegate, inFlight })
  );

  // cancel is best-effort: MCP tool calls are serialized, so delegate must finish first.
  server.registerTool(
    "cancel",
    { description: "Cancel an in-flight ACP delegation by sessionId.", inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) => {
      const client = inFlight.get(sessionId);
      if (client) {
        await client.cancel(sessionId).catch(() => {});
        inFlight.delete(sessionId);
        return { content: [{ type: "text", text: `cancelled ${sessionId}` }] };
      }
      return { content: [{ type: "text", text: `no in-flight session ${sessionId}` }] };
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
    },
    async ({ deep }) => {
      const out = await runDoctor({
        deep,
        getClientInfo: () => ({
          capabilities: server.server.getClientCapabilities(),
          version: server.server.getClientVersion(),
        }),
      });
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  return server;
}

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
