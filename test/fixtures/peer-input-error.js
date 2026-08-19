// Emits an error on the stream a JsonRpcPeer is reading, the way a broken pipe to the agent's
// stdout does. Exits 0 if the peer survived it, 7 if it became an uncaught exception. Runs in
// its own process because that is the only place the difference is observable.
import process from "node:process";
import { PassThrough } from "node:stream";
import { JsonRpcPeer } from "../../src/jsonrpc.js";

const input = new PassThrough();
const output = new PassThrough();
// The guard acp-client.js installs on the child's stdout. The interface re-emits regardless.
input.on("error", () => {});
new JsonRpcPeer(input, output, {});

process.on("uncaughtException", (err) => {
  console.error(`uncaught: ${err?.message || err}`);
  process.exit(7);
});
input.emit("error", new Error("EPIPE"));
setTimeout(() => process.exit(0), 100);
