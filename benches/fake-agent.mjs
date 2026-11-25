// An in-memory cursor-agent for the benchmarks: the real AcpClient talks to it through a fake child
// process, so a delegation runs the whole bridge (framing, JSON-RPC, routing, turn state, result
// assembly) without spawning anything. Turn frames are serialized once, up front, so the agent side
// costs almost nothing next to the bridge.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const SESSION_ID = "sess-bench";
// What a pipe hands the reader per read on Linux.
const PIPE_CHUNK = 64 * 1024;

const frame = (obj) => JSON.stringify(obj) + "\n";
const update = (u) => frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update: u } });
const text = (sessionUpdate, t) => update({ sessionUpdate, content: { type: "text", text: t } });

// Cursor streams thoughts and answers a few words at a time.
function* words(sentenceCount, seed) {
  for (let i = 0; i < sentenceCount; i++) {
    const sentence = `Step ${seed}-${i} checks the handler in src/module${i % 7}.js and keeps the existing behaviour. `;
    for (const w of sentence.match(/\S+\s*/g)) yield w;
  }
}

/** An `ask` turn: a long thought stream, then a long answer, no tools. */
export function askTurnFrames() {
  const frames = [update({ sessionUpdate: "session_info_update", title: "Review Session Store" })];
  for (const w of words(80, "think")) frames.push(text("agent_thought_chunk", w));
  for (const w of words(120, "answer")) frames.push(text("agent_message_chunk", w));
  return frames;
}

/** An `agent` turn: todos, a plan, and edit tool calls with permission requests and diffs. */
export function agentTurnFrames({ tools = 40 } = {}) {
  const frames = [update({ sessionUpdate: "session_info_update", title: "Migrate Callbacks" })];
  const todos = Array.from({ length: 8 }, (_, i) => ({ id: `todo-${i}`, content: `Migrate module ${i}`, status: "pending" }));
  frames.push(frame({ jsonrpc: "2.0", method: "cursor/update_todos", params: { todos, merge: false } }));
  frames.push(update({
    sessionUpdate: "plan",
    entries: todos.map((t) => ({ content: t.content, priority: "medium", status: "pending" })),
  }));
  let requestId = 10_000;
  for (let i = 0; i < tools; i++) {
    for (const w of words(2, `pre${i}`)) frames.push(text("agent_thought_chunk", w));
    for (const w of words(1, `msg${i}`)) frames.push(text("agent_message_chunk", w));
    const toolCallId = `tool_${i}`;
    const path = `src/module${i % 12}/file${i}.js`;
    frames.push(update({ sessionUpdate: "tool_call", toolCallId, title: "Edit File", kind: "edit", status: "pending", rawInput: {} }));
    frames.push(frame({
      jsonrpc: "2.0", id: requestId++, method: "session/request_permission",
      params: {
        sessionId: SESSION_ID,
        toolCall: { toolCallId },
        options: [
          { optionId: "reject-once", kind: "reject_once", name: "Reject" },
          { optionId: "allow-once", kind: "allow_once", name: "Allow" },
          { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
        ],
      },
    }));
    frames.push(update({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", title: `Edit ${path}`, locations: [{ path }] }));
    frames.push(update({
      sessionUpdate: "tool_call_update", toolCallId, status: "completed",
      content: [{ type: "diff", path, oldText: "callback(err, value);\n".repeat(20), newText: "return await value;\n".repeat(20) }],
    }));
    if (i % 5 === 4) {
      const done = Math.min(todos.length, (i + 1) / 5);
      frames.push(frame({
        jsonrpc: "2.0", method: "cursor/update_todos",
        params: { merge: true, todos: todos.slice(0, done).map((t) => ({ ...t, status: "completed" })) },
      }));
    }
  }
  for (const w of words(30, "report")) frames.push(text("agent_message_chunk", w));
  return frames;
}

/** Concatenates frames into the chunks a pipe would deliver, cutting through frames like a pipe does. */
export function toChunks(frames) {
  const all = frames.join("");
  const chunks = [];
  for (let i = 0; i < all.length; i += PIPE_CHUNK) chunks.push(all.slice(i, i + PIPE_CHUNK));
  return chunks;
}

const SESSION_NEW_RESULT = {
  sessionId: SESSION_ID,
  models: { currentModelId: "composer-2.5", availableModels: [{ modelId: "composer-2.5" }, { modelId: "grok-4.7" }] },
  modes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
  configOptions: [
    { id: "model", currentValue: "composer-2.5", options: [{ value: "composer-2.5" }, { value: "grok-4.7" }] },
    { id: "fast", currentValue: "false", options: [{ value: "false" }, { value: "true" }] },
  ],
};

/**
 * A ChildProcess look-alike that answers the setup requests and plays turnChunks for session/prompt.
 * @param {string[]} turnChunks
 */
function fakeChild(turnChunks) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const reply = (id, result) => stdout.write(frame({ jsonrpc: "2.0", id, result }));
  // The bridge writes one whole frame per write().
  const stdin = new Writable({
    write(chunk, _enc, done) {
      const msg = JSON.parse(chunk.toString());
      switch (msg.method) {
        case "initialize":
          reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
          break;
        case "session/new":
          reply(msg.id, SESSION_NEW_RESULT);
          break;
        case "session/prompt":
          // Written synchronously: spreading chunks over event-loop turns adds event-loop syscalls
          // that make the simulated measurement unstable.
          for (const c of turnChunks) stdout.write(c);
          reply(msg.id, { stopReason: "end_turn" });
          break;
        default:
          // Setup requests get an empty result; responses to the agent's own requests need none.
          if (msg.method && msg.id !== undefined) reply(msg.id, {});
      }
      done();
    },
  });
  Object.assign(child, {
    stdin, stdout, stderr: new PassThrough(),
    // No pid: stopChild has no process tree to kill and returns at once.
    pid: undefined, exitCode: null, signalCode: null,
    kill() {},
  });
  process.nextTick(() => child.emit("spawn"));
  return child;
}

/**
 * A ChildRegistry for AcpClient that hands back the in-memory agent instead of spawning.
 * @param {string[]} turnChunks
 */
export function fakeAgentRegistry(turnChunks) {
  return {
    track: () => fakeChild(turnChunks),
    stopAll: async () => {},
  };
}
