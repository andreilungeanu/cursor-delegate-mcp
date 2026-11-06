// A deterministic ACP agent for the durable-lifecycle integration tests. It performs no file,
// network, or production work; prompt completion is controlled only by a timer.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const durationMs = Number(process.env.ASYNC_ACP_DURATION_MS || 1000);
const sessionId = process.env.ASYNC_ACP_SESSION_ID || "async-session";
const logPath = process.env.ASYNC_ACP_LOG;
let promptRequest = null;
let promptTimer;

function log(event) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ event, at: Date.now() })}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function update(sessionUpdate) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: sessionUpdate },
  });
}

function finishPrompt(stopReason = "end_turn") {
  if (!promptRequest) return;
  clearTimeout(promptTimer);
  const request = promptRequest;
  promptRequest = null;
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "wait-for-timer",
    status: "completed",
  });
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: stopReason === "cancelled" ? "cancelled by request" : "long task completed" },
  });
  response(request.id, { stopReason });
}

process.on("exit", () => {
  if (promptTimer) clearTimeout(promptTimer);
});

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    response(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
      },
    });
    return;
  }
  if (message.method === "session/new" || message.method === "session/load") {
    response(message.id, {
      sessionId,
      models: { currentModelId: "composer-2.5" },
      configOptions: [
        {
          id: "model",
          currentValue: "composer-2.5",
          options: [{ value: "composer-2.5" }],
        },
        {
          id: "fast",
          currentValue: "true",
          options: [{ value: "false" }, { value: "true" }],
        },
      ],
      modes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
    });
    return;
  }
  if (message.method === "session/set_model" || message.method === "session/set_mode") {
    response(message.id, {});
    return;
  }
  if (message.method === "session/set_config_option") {
    response(message.id, {
      configOptions: [
        {
          id: "model",
          currentValue: "composer-2.5",
          options: [{ value: "composer-2.5" }],
        },
      ],
    });
    return;
  }
  if (message.method === "session/prompt") {
    log("prompt");
    promptRequest = message;
    update({
      sessionUpdate: "tool_call",
      toolCallId: "wait-for-timer",
      title: "Wait for controlled lifecycle fixture",
      kind: "shell",
      status: "in_progress",
    });
    promptTimer = setTimeout(() => finishPrompt(), durationMs);
    promptTimer.unref?.();
    return;
  }
  if (message.method === "session/cancel") {
    log("cancel");
    finishPrompt("cancelled");
  }
});
