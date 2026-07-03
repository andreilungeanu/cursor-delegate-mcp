// Completes handshake; hangs on prompt until killed. Logs cancel receipt on stderr.
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function handshake(m) {
  if (m.method === "initialize") {
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (m.method === "session/new") {
    return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-escalate", models: { currentModelId: "composer-2.5" }, configOptions: [] } });
  }
  if (m.method === "session/set_model") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/set_config_option") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/set_mode") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  return false;
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (handshake(m)) return;
  if (m.method === "session/cancel") {
    process.stderr.write("got-cancel\n");
    return;
  }
});
