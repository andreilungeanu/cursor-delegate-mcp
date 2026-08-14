// A fake ACP server that emits one schema-illegal frame: tool_call_update with `content` as an
// object where ACP requires an array. The bridge must ignore it and finish the turn — iterating
// it raised "object is not iterable" inside the readline callback, which is an uncaught
// exception, so the whole MCP server died on one bad frame from the agent.
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (m.method === "session/new") {
    return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-bad", models: { currentModelId: "composer-2.5" }, configOptions: [
      { id: "fast", currentValue: "false", options: [{ value: "false" }, { value: "true" }] },
    ] } });
  }
  if (m.method === "session/set_config_option" || m.method === "session/set_mode" || m.method === "session/set_model") {
    return out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  if (m.method === "session/prompt") {
    const sid = m.params?.sessionId || "sess-bad";
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit File", kind: "edit", status: "pending",
    } } });
    // The bad frame: an object, not an array of content blocks.
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
      content: { type: "diff", path: "hello.txt" },
    } } });
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" },
    } } });
    return out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
  if (m.method === "session/cancel") return out({ jsonrpc: "2.0", id: m.id, result: {} });
});
