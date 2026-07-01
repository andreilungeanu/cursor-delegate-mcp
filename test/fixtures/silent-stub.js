// Completes handshake then hangs silently on session/prompt (no stdout).
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
    return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-silent", models: { currentModelId: "composer-2.5" }, configOptions: [] } });
  }
  if (m.method === "session/set_model") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/set_config_option") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/set_mode") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  // session/prompt and session/cancel: intentionally silent
});
