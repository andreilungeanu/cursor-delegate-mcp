// Stands in for cursor-agent with no behaviour of its own: every line the bridge writes goes to the
// test's control socket (127.0.0.1:SCRIPTED_AGENT_PORT), and every line the test sends is written to
// stdout, except {"exit": code}. stdin EOF ends the connection and the process.
import net from "node:net";
import process from "node:process";
import readline from "node:readline";

// noDelay: Nagle would hold a frame the test sends shortly after another until the next frame
// back, reordering it against the bridge.
const control = net.connect({ port: Number(process.env.SCRIPTED_AGENT_PORT), host: "127.0.0.1", noDelay: true });
control.on("connect", () => {
  readline.createInterface({ input: process.stdin })
    .on("line", (line) => control.write(line + "\n"))
    .on("close", () => control.end());
});
readline.createInterface({ input: control }).on("line", (line) => {
  const command = JSON.parse(line);
  if ("exit" in command) process.exit(command.exit);
  process.stdout.write(line + "\n");
});
control.on("close", () => process.exit(0));
control.on("error", () => process.exit(1));
