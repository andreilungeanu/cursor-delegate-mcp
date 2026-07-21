// Answers initialize and session/new, then hangs on set_model — the window where a
// handshake timeout leaves a live, resumable session behind.
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (m.method === "session/new") {
    return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-half-open", models: { currentModelId: "composer-2.5" }, configOptions: [] } });
  }
  // Everything after this point goes unanswered.
});
