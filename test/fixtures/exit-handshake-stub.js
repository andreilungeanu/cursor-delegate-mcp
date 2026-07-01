// Exits during handshake with stderr after receiving initialize.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    process.stderr.write("handshake-boom\n");
    process.exit(2);
  }
});
