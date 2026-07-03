// A fake ACP server: reads newline JSON-RPC on stdin, replies on stdout. Prompt streams a
// diff-edit tool_call pair + message chunk + end_turn; plan mode adds session/update:plan (twice, latest wins) + cursor/create_plan.
import readline from "node:readline";

const CREATE_PLAN_REQ_ID = 9001;
let currentMode = "agent";
let pendingPrompt = null;

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function finishAgentPrompt(m) {
  const sid = m.params?.sessionId || "sess-1";
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
    sessionUpdate: "tool_call", toolCallId: "tool_fake-1", title: "Edit File", kind: "edit", status: "pending", rawInput: {},
  } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
    sessionUpdate: "tool_call_update", toolCallId: "tool_fake-1", status: "in_progress",
  } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
    sessionUpdate: "tool_call_update", toolCallId: "tool_fake-1", status: "completed",
    content: [{ type: "diff", path: "hello.txt", oldText: "-- /dev/null\n", newText: "++ b/hello.txt\ntest" }],
  } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
  out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
}

function startPlanPrompt(m) {
  const sid = m.params?.sessionId || "sess-1";
  pendingPrompt = m;
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
    sessionUpdate: "plan",
    entries: [{ content: "stale step", priority: "low", status: "pending" }],
  } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
    sessionUpdate: "plan",
    entries: [{ content: "Create CHANGELOG.md", priority: "medium", status: "pending" }],
  } } });
  out({ jsonrpc: "2.0", id: CREATE_PLAN_REQ_ID, method: "cursor/create_plan", params: {
    name: "Add CHANGELOG",
    overview: "Add a changelog file",
    plan: "# Plan\n\n1. Create CHANGELOG.md",
  } });
}

function finishPlanPrompt(m) {
  const sid = m.params?.sessionId || "sess-1";
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text: "plan ready" },
  } } });
  out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id === CREATE_PLAN_REQ_ID && (m.result !== undefined || m.error !== undefined) && pendingPrompt) {
    const pm = pendingPrompt;
    pendingPrompt = null;
    finishPlanPrompt(pm);
    return;
  }
  if (m.method === "initialize") {
    const param = !!m.params?.clientCapabilities?._meta?.parameterizedModelPicker;
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { parameterizedModelPicker: param } } });
  }
  if (m.method === "session/new") return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-1", models: { currentModelId: "composer-2.5" }, configOptions: [
    { id: "model", currentValue: "composer-2.5", options: [{ value: "composer-2.5" }] },
    { id: "fast", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
  ] } });
  if (m.method === "session/load") {
    const sessionId = m.params?.sessionId;
    if (!sessionId || sessionId === "unknown") {
      const label = sessionId || "";
      return out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Invalid params", data: { message: `Session "${label}" not found` } } });
    }
    return out({ jsonrpc: "2.0", id: m.id, result: {
      modes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
      models: { currentModelId: "composer-2.5" },
      configOptions: [
        { id: "model", currentValue: "composer-2.5", options: [{ value: "composer-2.5" }] },
        { id: "fast", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
      ],
    } });
  }
  if (m.method === "session/set_model") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/set_config_option") {
    if (m.params?.configId) return out({ jsonrpc: "2.0", id: m.id, result: {} });
    return out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error" } });
  }
  if (m.method === "session/set_mode") {
    currentMode = m.params?.modeId || "agent";
    return out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  if (m.method === "session/prompt") {
    if (!Array.isArray(m.params?.prompt)) {
      return out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error" } });
    }
    if (currentMode === "plan") return startPlanPrompt(m);
    return finishAgentPrompt(m);
  }
  if (m.method === "session/cancel") return out({ jsonrpc: "2.0", id: m.id, result: {} });
});
