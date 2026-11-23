import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { AcpClient } from "../src/acp-client.js";
import { isChildAlive } from "../src/proc.js";
import { runDelegate } from "../src/delegate.js";
import { buildServer } from "../src/server.js";
import { createTaskStore, runAsTask } from "../src/tasks.js";
import { mkdtemp } from "./fixtures/temp-dir.mjs";

const AGENT = fileURLToPath(new URL("./fixtures/scripted-agent.js", import.meta.url));
const SPEC = "Do the phase task.";
const CHATTER = "setup chatter";
const DONE = "TASK DONE";
// Read one by one before the prompt goes out, which holds the attachment phase open long enough
// for a frame to land in it.
const IMAGES = 40;
const FORCE_GRACE_MS = 1000;
const HELD_SETUP_MS = 1000;
const HANDSHAKE_MS = 2500;
const HEARTBEAT_MS = 20;
// Every stop waits this long before it kills, as a taskkill does on Windows; replies the agent sends
// meanwhile reach the bridge.
const SLOW_KILL_MS = 300;

const BARRIERS = ["initialize", "session/new", "set_model", "set_config_option", "set_mode", "prompt", "turn"];
const BEFORE_SESSION = ["initialize", "session/new"];
const SETUP = ["set_model", "set_config_option", "set_mode"];
const TURN = ["prompt", "turn"];
const EVENTS = ["cancel", "cancel-force", "abort", "exit"];
const CASES = [
  ...BARRIERS.flatMap((barrier) => EVENTS.map((event) => ({ barrier, event }))),
  ...[...BEFORE_SESSION, ...SETUP].map((barrier) => ({ barrier, event: "timeout" })),
  { barrier: "set_config_option", event: "cancel", release: "error" },
  { barrier: "set_mode", event: "cancel", release: "error" },
];

const caseName = (c) => [c.event, c.release && "then agent fails the held call", "at", c.barrier].filter(Boolean).join(" ");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, ms) {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await sleep(5);
}
const message = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const modelOption = (current) => ({
  id: "model", name: "Model", category: "model", type: "select", currentValue: current,
  options: [{ value: "model-a", name: "model-a" }, { value: "model-b", name: "model-b" }],
});
const MODELS = { availableModels: [{ modelId: "model-a" }, { modelId: "model-b" }], currentModelId: "model-a" };
const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { promptCapabilities: { image: true } },
  agentInfo: { name: "scripted-agent", version: "0" },
};
const TEARDOWN = { marker: "teardown" };

function readResult(res) {
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) return { error: text, reason: /^delegate failed \[([^\]]+)\]/.exec(text)?.[1] };
  return { out: JSON.parse(text) };
}

// The test's end of scripted-agent.js: every frame the bridge sent, in order, and a way back.
class Agent {
  static async listen() {
    const agent = new Agent();
    await new Promise((resolve) => agent.server.listen(0, "127.0.0.1", () => resolve(undefined)));
    return agent;
  }
  constructor() {
    this.received = [];
    this.alive = false;
    this.onFrame = (_frame) => {};
    this.gone = new Promise((resolve) => { this._gone = resolve; });
    this.server = net.createServer({ noDelay: true }, (socket) => {
      this.socket = socket;
      this.alive = true;
      socket.on("error", () => {});
      socket.on("close", () => { this.alive = false; this.server.close(); this._gone(); });
      // readline re-emits the socket's error, a reset when the bridge kills the agent.
      readline.createInterface({ input: socket }).on("error", () => {}).on("line", (line) => {
        const frame = JSON.parse(line);
        this.received.push(frame);
        this.onFrame(frame);
      });
    });
  }
  get port() { return /** @type {net.AddressInfo} */ (this.server.address()).port; }
  send(command) { if (this.alive) this.socket.write(JSON.stringify(command) + "\n"); }
  reply(frame, result) { this.send({ jsonrpc: "2.0", id: frame.id, result }); }
  fail(frame, code, text) { this.send({ jsonrpc: "2.0", id: frame.id, error: { code, message: text } }); }
  update(sessionId, update) { this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }); }
  exit(code) { this.send({ exit: code }); }
}

// A real AcpClient on scripted-agent.js, with a slow stop. Each stop first writes a marker down the
// agent's stdin, so everything received after it was sent once teardown began.
function scriptedClient(agent, o, factoryOpts) {
  const env = { ...process.env, SCRIPTED_AGENT_PORT: String(agent.port) };
  const bridge = new AcpClient({ ...factoryOpts, spawnSpec: { command: process.execPath, args: [AGENT], options: { shell: false, env } } });
  o.bridge = bridge;
  const stop = bridge.stop.bind(bridge);
  bridge.stop = async (...args) => {
    if (isChildAlive(bridge.child)) bridge.child.stdin.write(JSON.stringify(TEARDOWN) + "\n");
    o.stopCalled = true;
    await sleep(SLOW_KILL_MS);
    return stop(...args);
  };
  return bridge;
}

const sentAfterTeardown = (received) => {
  const at = received.findIndex((f) => f.marker === TEARDOWN.marker);
  return at < 0 ? [] : received.slice(at + 1).filter((f) => f.id !== undefined && f.method);
};

let caseCount = 0;
let chatterChecked = 0;
async function runCase(c) {
  const agent = await Agent.listen();
  const sid = `sess-phases-${process.pid}-${++caseCount}`;
  const o = { received: agent.received, sid, lateProgress: [] };
  let order = 0;

  let bridgeExited;
  const bridgeExit = new Promise((resolve) => { bridgeExited = resolve; });
  let serverSettled;
  const serverDone = new Promise((resolve) => { serverSettled = resolve; });
  const runInCase = (opts) => {
    let returned = false;
    const run = runDelegate({
      ...opts,
      onProgress: (m) => {
        if (returned) o.lateProgress.push(m);
        opts.onProgress?.(m);
      },
      onSessionReady: (...args) => {
        o.announced = true;
        opts.onSessionReady?.(...args);
      },
      clientFactory: (factoryOpts) => {
        const bridge = scriptedClient(agent, o, factoryOpts);
        bridge.once("exit", () => bridgeExited());
        // Orders the chatter's arrival against the task prompt going out, so a frame that crossed
        // the prompt on the wire is not mistaken for one sent before it.
        bridge.on("update", (u) => { if (u?.update?.content?.text === CHATTER) o.chatterAt ??= ++order; });
        const prompt = bridge.prompt.bind(bridge);
        bridge.prompt = (...args) => { o.promptAt ??= ++order; return prompt(...args); };
        return bridge;
      },
      heartbeatMs: HEARTBEAT_MS,
      handshakeMs: c.event === "timeout" ? HANDSHAKE_MS : 15000,
    });
    run.then((value) => ({ value }), (error) => ({ error })).then((outcome) => {
      returned = true;
      o.agentExitedAtReturn = !isChildAlive(o.bridge?.child);
      o.server = outcome;
      serverSettled();
    });
    return run;
  };

  const mcp = buildServer({ runDelegate: runInCase, forceGraceMs: FORCE_GRACE_MS });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const host = new Client({ name: "phases-host", version: "1" });
  await Promise.all([mcp.connect(serverTransport), host.connect(clientTransport)]);
  const status = async (name, args) => JSON.parse((await host.callTool({ name, arguments: args })).content[0].text).status;

  const abort = new AbortController();
  const hostDone = host.callTool(
    { name: "delegate", arguments: { spec: SPEC, workspace, model: "model-b", contextFiles } },
    { signal: abort.signal, timeout: 30000 },
  ).then(readResult, (error) => ({ rejected: String(error?.message ?? error) }));
  hostDone.then((result) => { o.result = result; });

  let eventStarted = false;
  let eventSettled = Promise.resolve();
  const unanswered = new Set();
  const answer = (frame, result) => { if (unanswered.delete(frame)) agent.reply(frame, result); };

  // Fires the case's event. release() lets the agent answer the request it holds.
  async function fire(release) {
    const arrived = (match) => until(() => agent.received.some(match), 1000);
    if (c.event === "cancel" || c.event === "cancel-force") {
      o.cancel = await status("cancel", { sessionId: sid, force: c.event === "cancel-force" });
      if (o.cancel === "cancelled") await arrived((f) => f.method === "session/cancel");
      if (c.release === "error") release("error");
      else if (c.event === "cancel" && SETUP.includes(c.barrier)) o.endedWithSetupHeld = await within(hostDone, HELD_SETUP_MS);
    } else if (c.event === "abort") {
      abort.abort();
      await until(() => o.stopCalled, 5000);
    } else if (c.event === "timeout") {
      await until(() => o.stopCalled, HANDSHAKE_MS * 2);
    } else {
      agent.exit(1);
      await within(bridgeExit, 5000);
    }
    release("reply");
  }

  function gate(phase) {
    if (phase !== c.barrier) return Promise.resolve("reply");
    eventStarted = true;
    return new Promise((release) => { eventSettled = fire(release); });
  }

  async function held(phase, frame, result) {
    const release = await gate(phase);
    if (release === "error") agent.fail(frame, -32603, "Internal error");
    else agent.reply(frame, result);
    return release;
  }

  async function onTask(frame) {
    unanswered.add(frame);
    await gate("prompt");
    if (!unanswered.has(frame) || !agent.alive) return;
    agent.update(sid, message("Working. "));
    await gate("turn");
    if (eventStarted) await eventSettled;
    if (!unanswered.has(frame)) return;
    agent.update(sid, message(DONE));
    answer(frame, { stopReason: "end_turn" });
  }

  agent.onFrame = (frame) => {
    switch (frame.method) {
      case "initialize": return held("initialize", frame, INITIALIZE);
      case "session/new": return held("session/new", frame, { sessionId: sid, models: MODELS, configOptions: [modelOption("model-a")] });
      case "session/set_model": return held("set_model", frame, {});
      case "session/set_config_option": return held("set_config_option", frame, { configOptions: [modelOption("model-b")] });
      case "session/set_mode":
        return held("set_mode", frame, {}).then((release) => {
          // Lands while the bridge reads the attachments, before the task prompt is out.
          if (release === "reply") setTimeout(() => agent.update(sid, message(CHATTER)), 2);
        });
      case "session/prompt": return onTask(frame);
      case "session/cancel":
        for (const f of [...unanswered]) answer(f, { stopReason: "cancelled" });
        return;
      default: if (frame.id !== undefined && frame.method) agent.fail(frame, -32601, `Method not found: ${frame.method}`);
    }
  };

  await hostDone;
  await eventSettled;
  await within(serverDone, 10000);
  o.agentExited = await within(agent.gone, 5000);
  if (!o.agentExited) { agent.exit(1); await within(agent.gone, 2000); }
  o.cancelAfter = await status("cancel", { sessionId: sid, force: false });
  // A leaked heartbeat ticks every HEARTBEAT_MS.
  await sleep(HEARTBEAT_MS * 5);
  await host.close();
  return o;
}

function violations(c, o) {
  const v = [];
  const rule = (holds, text) => { if (!holds) v.push(text); };
  const show = JSON.stringify;
  const methods = (frames) => frames.map((f) => f.method);
  const prompts = o.received.filter((f) => f.method === "session/prompt");
  const cancelAt = o.received.findIndex((f) => f.method === "session/cancel");
  const afterCancel = cancelAt < 0 ? [] : o.received.slice(cancelAt + 1).filter((f) => f.id !== undefined && f.method);
  const { out, reason } = o.result;
  const result = out?.result ?? "";
  const got = out
    ? show({ result: out.result, stopReason: out.stopReason, resultSource: out.resultSource, cancelRequested: out.cancelRequested })
    : show(o.result).slice(0, 300);
  const registered = !BEFORE_SESSION.includes(c.barrier);
  const finishedTask = () => result.includes(DONE) && out.stopReason === undefined && out.cancelRequested === undefined;

  rule(sentAfterTeardown(o.received).length === 0,
    `the agent receives no request once teardown began; it got ${show(methods(sentAfterTeardown(o.received)))}`);
  rule(afterCancel.length === 0, `the agent receives no request after a session/cancel; it got ${show(methods(afterCancel))}`);
  if (o.chatterAt !== undefined && !(o.promptAt < o.chatterAt)) {
    chatterChecked++;
    rule(!result.includes(CHATTER), `a frame the agent sent while attachments were read stays out of the result; result ${show(result)}`);
  }
  rule(o.agentExitedAtReturn, "the agent has exited by the time the delegation returns");
  rule(o.lateProgress.length === 0, `no progress is reported once the delegation returned; got ${show(o.lateProgress.slice(0, 3))}`);
  const afterReturn = o.announced ? "not-running" : "not-found";
  rule(o.cancelAfter === afterReturn, `cancel reports ${afterReturn} once the delegate call has returned; got ${o.cancelAfter}`);
  const cancels = o.received.filter((f) => f.method === "session/cancel");
  rule(cancels.every((f) => f.id === undefined && f.params?.sessionId === o.sid),
    `a cancel reaches the agent as a session/cancel notification naming the session; it got ${show(cancels)}`);

  if (c.event === "cancel" || c.event === "cancel-force") {
    if (!registered) {
      rule(o.cancel === "not-found", `cancel before the session id is announced reports not-found; got ${o.cancel}`);
      rule(cancelAt < 0 && finishedTask(), `a cancel for an id not yet announced leaves the delegation running; got ${got}`);
    } else if (SETUP.includes(c.barrier)) {
      rule(o.cancel === "cancelled", `cancel during setup reports cancelled; got ${o.cancel}`);
      if (o.endedWithSetupHeld !== undefined) {
        rule(o.endedWithSetupHeld, `a cancel before the prompt ends setup at once, with the agent's ${c.barrier} reply still held`);
      }
      rule(prompts.length === 0, "the agent receives no task prompt after a cancel during setup");
      rule(out?.stopReason === "cancelled", c.release === "error"
        ? `a cancel before the prompt returns stopReason cancelled even when the agent then fails the held call; got ${got}`
        : `a cancel before the prompt returns stopReason cancelled; got ${got}`);
      rule(out?.result === "" && out?.resultSource === "none", `a setup-cancelled delegation returns an empty result with resultSource none; got ${got}`);
      rule(out && !out.protocolWarnings && !out.filesReportedByEditTools,
        `a setup-cancelled delegation reports no warnings and no files; got ${show(out?.protocolWarnings)} ${show(out?.filesReportedByEditTools)}`);
    } else {
      rule(o.cancel === "cancelled", `cancel while the turn runs reports cancelled; got ${o.cancel}`);
      rule(cancelAt >= 0, "a cancel while the turn runs reaches the agent as session/cancel");
      rule(out?.stopReason === "cancelled" && out.cancelRequested === true,
        `a cancelled turn returns stopReason cancelled and cancelRequested; got ${got}`);
    }
  }

  if (c.event === "abort") {
    rule(o.server?.error?.reason === "aborted", `an abort fails the delegation as aborted; got ${show(o.server).slice(0, 300)}`);
    if (!TURN.includes(c.barrier)) {
      rule(prompts.length === 0, "the agent receives no task prompt after an abort during setup");
    }
  }

  if (c.event === "timeout") {
    rule(reason === "handshake-timeout", `a stalled handshake fails the delegation as handshake-timeout; got ${got}`);
    rule(prompts.length === 0, "the agent receives no task prompt after a handshake timeout");
  }

  if (c.event === "exit") {
    rule(reason === "agent-exit", `the agent exiting fails the delegation as agent-exit; got ${got}`);
  }
  return v;
}

const workspace = await mkdtemp(path.join(tmpdir(), "cursor-phases-"));
const contextFiles = Array.from({ length: IMAGES }, (_, i) => {
  writeFileSync(path.join(workspace, `shot-${i}.png`), Buffer.alloc(64, i));
  return `shot-${i}.png`;
});

test("every host event in every phase of a delegation keeps the delegation's rules", async (t) => {
  const started = Date.now();
  for (const c of CASES) {
    await t.test(caseName(c), async () => {
      const found = violations(c, await runCase(c));
      if (found.length) assert.fail(found.join("\n"));
    });
  }
  t.diagnostic(`${CASES.length} cases in ${Date.now() - started} ms, ${chatterChecked} with the agent's chatter before the prompt`);
  assert.ok(chatterChecked > 0, "no case had the agent's chatter arrive before the task prompt, so that rule never ran");
});

// initialize is answered only once the stop began: with no session yet, no session/cancel goes out.
test("a handshake timeout answers a task-mode request with its error, not a task id", async () => {
  const agent = await Agent.listen();
  const o = {};
  agent.onFrame = async (frame) => {
    if (frame.id === undefined || !frame.method) return;
    if (frame.method === "initialize") await until(() => o.stopCalled, HANDSHAKE_MS * 2);
    const results = {
      initialize: INITIALIZE,
      "session/new": { sessionId: "sess-task-timeout", models: MODELS, configOptions: [modelOption("model-a")] },
      "session/set_config_option": { configOptions: [modelOption("model-b")] },
    };
    if (frame.method === "session/prompt") return agent.reply(frame, { stopReason: "end_turn" });
    agent.reply(frame, results[frame.method] ?? {});
  };
  const answer = await runAsTask({
    run: (over) => runDelegate({
      spec: SPEC, workspace, model: "model-b", handshakeMs: HANDSHAKE_MS, heartbeatMs: 0,
      clientFactory: (factoryOpts) => scriptedClient(agent, o, factoryOpts), ...over,
    }),
    store: createTaskStore(),
  }).then((value) => ({ value }), (error) => ({ error }));
  await within(agent.gone, 5000);
  assert.equal(answer.error?.reason, "handshake-timeout", JSON.stringify(answer.value ?? String(answer.error)));
});
