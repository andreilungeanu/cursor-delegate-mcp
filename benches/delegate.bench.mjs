// CodSpeed benchmarks for the bridge's own work on a delegation: reading cursor-agent's ACP stream
// and turning it into the delegate result. Run with `npm run bench`; under the CodSpeed runner each
// benchmark is measured, otherwise tinybench times it locally.
import assert from "node:assert/strict";
import process from "node:process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Bench } from "tinybench";
import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { AcpClient } from "../src/acp-client.js";
import { runDelegate } from "../src/delegate.js";
import { JsonRpcPeer } from "../src/jsonrpc.js";
import { makeTurnState } from "../src/turn-state.js";
import { agentTurnFrames, askTurnFrames, fakeAgentRegistry, toChunks } from "./fake-agent.mjs";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const noop = () => {};

const agentChunks = toChunks(agentTurnFrames());
const askChunks = toChunks(askTurnFrames());

// A whole delegation through the real AcpClient, with the agent replaced by an in-memory one.
function delegate(mode, chunks) {
  return runDelegate({
    spec: "Migrate src/api from callbacks to async/await and update the tests.",
    mode,
    workspace,
    onProgress: noop,
    clientFactory: (opts) => new AcpClient({
      ...opts,
      spawnSpec: { command: "cursor-agent", args: ["acp"], options: { shell: false } },
      registry: fakeAgentRegistry(chunks),
    }),
  });
}

// Fail fast if the fake agent stops producing the result the benchmark claims to measure.
{
  const agent = await delegate("agent", agentChunks);
  assert.equal(agent.filesReportedByEditTools?.length, 40);
  assert.equal(agent.todoProgress?.completed, 8);
  assert.ok(agent.result.length > 0 && !agent.protocolWarnings);
  const ask = await delegate("ask", askChunks);
  assert.ok(ask.result.length > 10_000 && !ask.protocolWarnings);
}

// The stream of the agent turn as the JSON-RPC layer alone sees it, with the prompt's reply last.
const PROMPT_ID = 1;
const peerChunks = toChunks([...agentTurnFrames(), JSON.stringify({ jsonrpc: "2.0", id: PROMPT_ID, result: { stopReason: "end_turn" } }) + "\n"]);

async function parseStream() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let notifications = 0;
  const peer = new JsonRpcPeer(input, output, {
    onNotification: () => { notifications++; },
    onRequest: (id) => peer.respond(id, {}),
  });
  const done = peer.request("session/prompt", { sessionId: "s", prompt: [] });
  for (const c of peerChunks) input.write(c);
  await done;
  peer.close();
  return notifications;
}

// The text updates of the ask turn, already parsed, for the turn state alone.
const askUpdates = askTurnFrames()
  .map((line) => JSON.parse(line).params.update)
  .filter((u) => u.content?.text);

function streamTurnState() {
  const state = makeTurnState({ onProgress: noop });
  for (const u of askUpdates) {
    if (u.sessionUpdate === "agent_thought_chunk") state.thoughts.push(u.content.text);
    else {
      if (state.collectingResult()) state.appendResult(u.content.text);
      state.messages.push(u.content.text);
    }
  }
  state.thoughts.end();
  state.messages.end();
  return state.text();
}

const bench = withCodSpeed(new Bench());

bench
  .add("delegate: agent turn with 40 edits", () => delegate("agent", agentChunks))
  .add("delegate: ask turn with a long answer", () => delegate("ask", askChunks))
  .add("jsonrpc: parse agent turn stream", parseStream)
  .add("turn-state: stream thoughts and answer", streamTurnState);

await bench.run();
console.table(bench.table());
// The heartbeat timer is unref'd and the fake agent holds nothing open, but exit explicitly anyway.
process.exit(0);
