// Completes handshake; streams session/update forever on prompt without completing.
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function handshake(m) {
  if (m.method === "initialize") {
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (m.method === "session/new") {
    return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-infinite", models: { currentModelId: "composer-2.5" }, configOptions: [] } });
  }
  if (m.method === "session/set_model") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/set_config_option") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/set_mode") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  return false;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (handshake(m)) return;
  if (m.method === "session/prompt") {
    const sid = m.params?.sessionId || "sess-infinite";
    let n = 0;
    setInterval(() => {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: `forever-${++n}` },
      } } });
    }, 30);
  }
});
