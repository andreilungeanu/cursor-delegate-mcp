import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryTransport, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AcpClient } from "../src/acp-client.js";
import { DEFAULT_MODEL, runDelegate as realRunDelegate } from "../src/delegate.js";
import { runDelegateTool, buildServer, delegateInputSchema, installSignalCleanup } from "../src/server.js";
import { TASKS_EXTENSION, createTaskStore } from "../src/tasks.js";

// Every tool returns its payload as one compact JSON text block and no structuredContent, so
// every assertion on their fields goes through here.
const payload = (res) => JSON.parse(res.content[0].text);

// Real AcpClient over a stub subprocess, so force-kill exercises the actual treeKill path.
function stubClientFactory(stubFile) {
  return ({ mode, onCreatePlan }) => new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL(`./fixtures/${stubFile}`, import.meta.url))],
      options: { shell: false },
    },
    mode,
    onCreatePlan,
  });
}

// Through serveStdio, the production entry, in each MCP era it serves: a 2025-era host opens with
// initialize; a 2026-07-28 one sends its identity and capabilities with every request.
const ERAS = [["2025", undefined], ["2026-07-28", { mode: { pin: "2026-07-28" } }]];
async function connectEra(versionNegotiation, serverOpts) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ ...serverOpts, era }), { transport: serverTransport });
  const client = new Client(
    { name: "era-host", version: "3" },
    { capabilities: { elicitation: { form: {} } }, ...(versionNegotiation ? { versionNegotiation } : {}) }
  );
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await served.close(); } };
}

test("doctor on a 2025-era connection reports the initialize identity over a request's envelope keys", async () => {
  const runDoctor = async ({ getClientInfo }) => getClientInfo();
  const { client, close } = await connectEra(undefined, { runDoctor });
  try {
    const info = payload(await client.callTool({
      name: "doctor",
      arguments: {},
      _meta: {
        [CLIENT_INFO_META_KEY]: { name: "per-request", version: "9" },
        [CLIENT_CAPABILITIES_META_KEY]: { sampling: {} },
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      },
    }));
    assert.equal(info.version?.name, "era-host");
    assert.deepEqual(info.capabilities?.elicitation, { form: {} });
    assert.match(info.protocolVersion, /^2025-/);
  } finally {
    await close();
  }
});

for (const [era, versionNegotiation] of ERAS) {
  test(`doctor reports the host's identity and protocol revision on a ${era}-era connection`, async () => {
    const runDoctor = async ({ getClientInfo }) => getClientInfo();
    const { client, close } = await connectEra(versionNegotiation, { runDoctor });
    try {
      const info = payload(await client.callTool({ name: "doctor", arguments: {} }));
      assert.equal(info.version?.name, "era-host");
      assert.deepEqual(info.capabilities?.elicitation, { form: {} });
      if (era === "2025") assert.match(info.protocolVersion, /^2025-/);
      else assert.equal(info.protocolVersion, "2026-07-28");
    } finally {
      await close();
    }
  });

  test(`delegate sends progress and sees the host's cancellation on a ${era}-era connection`, async () => {
    let aborted;
    const runDelegate = async ({ onProgress, onSessionReady, signal }) => {
      onSessionReady(`sess-${era}`, { cancel: async () => {}, stop: () => true });
      onProgress("tick");
      aborted = new Promise((resolve) => signal.addEventListener("abort", () => resolve(true), { once: true }));
      await aborted;
      return { result: "", sessionId: `sess-${era}` };
    };
    const { client, close } = await connectEra(versionNegotiation, { runDelegate });
    try {
      const host = new AbortController();
      const messages = [];
      let ticked;
      const tick = new Promise((resolve) => { ticked = resolve; });
      const call = client.callTool(
        { name: "delegate", arguments: { workspace: process.cwd(), spec: "x" } },
        { signal: host.signal, onprogress: (p) => { messages.push(p.message); if (p.message === "tick") ticked(); } }
      );
      await tick;
      assert.deepEqual(messages, [`session ready: sess-${era}`, "tick"]);
      host.abort();
      await assert.rejects(call);
      assert.equal(await aborted, true, "the host's cancellation must reach the delegation's signal");
    } finally {
      await close();
    }
  });
}

// Agents started through realOver. Closing a raw connection kills any still running, so a failed
// assertion cannot leave a hung agent holding the test process open.
const agentPids = [];

// A 2026-07-28 host in raw JSON-RPC: the SDK client fails a call answered with a task.
async function connectRaw(serverOpts) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(({ era }) => buildServer({ ...serverOpts, era }), { transport: serverTransport });
  const replies = new Map();
  const progress = [];
  let nextId = 0;
  clientTransport.onmessage = (m) => {
    if (m.id != null && replies.has(m.id)) { replies.get(m.id)(m); replies.delete(m.id); }
    else if (m.method === "notifications/progress") progress.push(m.params);
  };
  await clientTransport.start();
  const send = (method, params = {}, { tasks = true } = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve) => replies.set(id, resolve));
    clientTransport.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
      ...params._meta,
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: tasks ? { [TASKS_EXTENSION]: {} } : {} },
      [CLIENT_INFO_META_KEY]: { name: "raw-host", version: "1" },
    } } });
    return { id, reply };
  };
  await send("server/discover").reply;
  return {
    send,
    progress,
    call: (args = {}, { progressToken, tasks } = {}) => send("tools/call", {
      name: "delegate",
      arguments: { workspace: process.cwd(), spec: "x", ...args },
      ...(progressToken != null ? { _meta: { progressToken } } : {}),
    }, { tasks }),
    cancelRequest: (requestId) => clientTransport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "test" } }),
    close: async () => {
      await clientTransport.close();
      await served.close();
      for (const pid of agentPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    },
  };
}

async function waitForTask(raw, taskId, done = (t) => t.status !== "working", timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { result, error } = await raw.send("tasks/get", { taskId }).reply;
    if (error) throw new Error(`tasks/get ${taskId}: ${JSON.stringify(error)}`);
    if (done(result)) return result;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still ${result.status}: ${result.statusMessage}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
async function waitUntil(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return check();
}

// The real runDelegate over a fixture process, recording each agent's pid.
function realOver(stubFile, extra = {}, pids = []) {
  return (opts) => realRunDelegate({
    ...opts,
    handshakeMs: 10000,
    ...extra,
    clientFactory: (o) => {
      const client = stubClientFactory(stubFile)(o);
      const start = client.start.bind(client);
      client.start = async () => { const r = await start(); pids.push(client.child.pid); agentPids.push(client.child.pid); return r; };
      return client;
    },
  });
}

test("a 2026-07-28 connection advertises the tasks extension and a 2025-era one does not", async () => {
  const raw = await connectRaw({});
  try {
    const { result } = await raw.send("server/discover").reply;
    assert.deepEqual(result.capabilities.extensions?.[TASKS_EXTENSION], {});
  } finally {
    await raw.close();
  }
  const { client, close } = await connectEra(undefined, {});
  try {
    assert.equal(client.getServerCapabilities()?.extensions, undefined);
  } finally {
    await close();
  }
});

test("delegate answers a request listing the tasks extension with a task whose result matches a blocking call", async () => {
  const raw = await connectRaw({ runDelegate: realOver("fake-acp.js"), tasks: createTaskStore() });
  try {
    const answers = await Promise.all([raw.call().reply, raw.call().reply]);
    for (const { result } of answers) {
      assert.equal(result.resultType, "task");
      assert.match(result.taskId, /^[\x21-\x7e]{1,128}$/);
      assert.equal(result.status, "working");
      assert.equal(result.statusMessage, "session ready: sess-1");
      assert.equal(result.ttlMs, null);
      assert.equal(result.pollIntervalMs, 3000);
    }
    assert.notEqual(answers[0].result.taskId, answers[1].result.taskId);
    const blocking = await raw.call({}, { tasks: false }).reply;
    assert.equal(blocking.result.resultType, "complete");
    for (const { result } of answers) {
      const done = await waitForTask(raw, result.taskId);
      assert.equal(done.status, "completed");
      assert.deepEqual(done.result.content, blocking.result.content);
      assert.equal(typeof done.ttlMs, "number");
    }
  } finally {
    await raw.close();
  }
});

test("a task's progress goes to the request until the task is answered, then to its statusMessage", async () => {
  const raw = await connectRaw({ runDelegate: realOver("streaming-stub.js", { heartbeatMs: 100 }), tasks: createTaskStore() });
  try {
    const { result } = await raw.call({}, { progressToken: "tok" }).reply;
    assert.equal(result.resultType, "task");
    const beat = await waitForTask(raw, result.taskId, (t) => /^still working — /.test(t.statusMessage ?? ""));
    assert.equal(beat.status, "working");
    await waitForTask(raw, result.taskId);
    assert.deepEqual(raw.progress.filter((p) => p.progressToken === "tok").map((p) => p.message), ["session ready: sess-stream"]);
  } finally {
    await raw.close();
  }
});

test("cancelling a task request before its prompt is sent stops the agent and answers nothing", async () => {
  const pids = [];
  const raw = await connectRaw({ runDelegate: realOver("session-then-hang-stub.js", { handshakeMs: 30000 }, pids), tasks: createTaskStore() });
  try {
    const call = raw.call({}, { progressToken: "setup" });
    // The stub answers session/new, then nothing: the delegation is past spawn but short of its prompt.
    assert.ok(await waitUntil(() => raw.progress.some((p) => p.message === "session ready: sess-half-open")), "the session should open");
    raw.cancelRequest(call.id);
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the agent must be stopped");
    const answered = await Promise.race([call.reply.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
    assert.equal(answered, false);
  } finally {
    await raw.close();
  }
});

test("an argument the agent rejects before the prompt comes back at once, not as a task", async () => {
  const raw = await connectRaw({ runDelegate: realOver("fake-acp.js"), tasks: createTaskStore() });
  try {
    const { result } = await raw.call({ effort: "no-such-effort" }).reply;
    assert.equal(result.resultType, "complete");
    assert.equal(result.isError, true);
  } finally {
    await raw.close();
  }
});

test("tasks/cancel stops the agent and leaves the task cancelled with a resume hint", async () => {
  const pids = [];
  const raw = await connectRaw({ runDelegate: realOver("escalation-stub.js", {}, pids), tasks: createTaskStore() });
  try {
    const { result } = await raw.call().reply;
    assert.equal(result.resultType, "task");
    assert.equal((await raw.send("tasks/update", { taskId: result.taskId, inputResponses: { q: { action: "accept" } } }).reply).error, undefined);
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const { error } = await raw.send(method, { taskId: result.taskId }, { tasks: false }).reply;
      assert.equal(error?.code, -32021, `${method} from a request without the extension`);
    }
    const ack = await raw.send("tasks/cancel", { taskId: result.taskId }).reply;
    assert.equal(ack.error, undefined);
    const cancelled = (await raw.send("tasks/get", { taskId: result.taskId }).reply).result;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.statusMessage, "cancelled; resume with resumeSessionId sess-escalate");
    assert.equal(typeof cancelled.ttlMs, "number");
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the agent must be stopped");
    const ended = await waitForTask(raw, result.taskId, (t) => t.statusMessage.startsWith("delegate failed [aborted]"));
    assert.equal(ended.status, "cancelled");
    assert.match(ended.statusMessage, /resumeSessionId sess-escalate/);
    assert.equal(ended.ttlMs, cancelled.ttlMs);
    await raw.send("tasks/cancel", { taskId: result.taskId }).reply;
    assert.equal((await raw.send("tasks/get", { taskId: result.taskId }).reply).result.status, "cancelled");
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const { error } = await raw.send(method, { taskId: "no-such-task" }).reply;
      assert.equal(error?.code, -32602, method);
    }
  } finally {
    await raw.close();
  }
});

test("tasks/cancel stops only its own task when two run on one session", async () => {
  const pids = [];
  const raw = await connectRaw({ runDelegate: realOver("escalation-stub.js", {}, pids), tasks: createTaskStore() });
  try {
    const [a, b] = await Promise.all([raw.call().reply, raw.call().reply]);
    await raw.send("tasks/cancel", { taskId: a.result.taskId }).reply;
    await waitForTask(raw, a.result.taskId, (t) => /^delegate failed/.test(t.statusMessage));
    assert.equal(pids.filter(isAlive).length, 1, "the other task's agent must keep running");
    assert.equal((await raw.send("tasks/get", { taskId: b.result.taskId }).reply).result.status, "working");
    await raw.send("tasks/cancel", { taskId: b.result.taskId }).reply;
    assert.ok(await waitUntil(() => pids.every((pid) => !isAlive(pid))));
  } finally {
    await raw.close();
  }
});

test("cancel by task id reaches only that task's run, and a finished task's id reaches none", async () => {
  const pids = [];
  const raw = await connectRaw({ runDelegate: realOver("escalation-stub.js", {}, pids), tasks: createTaskStore(), forceGraceMs: 50 });
  const cancel = async (args) => payload((await raw.send("tools/call", { name: "cancel", arguments: args }).reply).result);
  try {
    // Two agents, each opening its own sess-escalate: one session id, two runs.
    const [a, b] = (await Promise.all([raw.call().reply, raw.call().reply])).map((r) => r.result);
    assert.deepEqual(await cancel({ sessionId: a.taskId, force: true }), { status: "killed", sessionId: "sess-escalate" });
    assert.equal(pids.filter(isAlive).length, 1, "the other task's agent must keep running");
    await waitForTask(raw, a.taskId);
    assert.deepEqual(await cancel({ sessionId: a.taskId, force: true }), { status: "not-running", sessionId: "sess-escalate" });
    assert.deepEqual(await cancel({ sessionId: b.taskId }), { status: "cancelled", sessionId: "sess-escalate" });
    assert.equal((await raw.send("tasks/get", { taskId: b.taskId }).reply).result.status, "working");
    await raw.send("tasks/cancel", { taskId: b.taskId }).reply;
    assert.ok(await waitUntil(() => pids.every((pid) => !isAlive(pid))));
  } finally {
    await raw.close();
  }
});

test("a task's id resumes the session its run opened, after tasks/cancel stopped it", async () => {
  const pids = [];
  const stopped = realOver("escalation-stub.js", {}, pids);
  const resumed = realOver("fake-acp.js");
  const raw = await connectRaw({ runDelegate: (opts) => (opts.resumeSessionId ? resumed : stopped)(opts), tasks: createTaskStore() });
  try {
    const { result: task } = await raw.call().reply;
    await raw.send("tasks/cancel", { taskId: task.taskId }).reply;
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the agent must be stopped");
    const out = payload((await raw.call({ resumeSessionId: task.taskId }, { tasks: false }).reply).result);
    assert.equal(out.sessionId, "sess-escalate");
    assert.equal(out.resumed, true);
  } finally {
    await raw.close();
  }
});

test("the shutdown on stdin EOF stops the agent of a task already answered", async () => {
  const pids = [];
  const inFlight = new Map();
  const pending = new Set();
  const raw = await connectRaw({ runDelegate: realOver("escalation-stub.js", {}, pids), tasks: createTaskStore(), inFlight, pending });
  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    const { result } = await raw.call().reply;
    assert.equal(result.resultType, "task");
    installSignalCleanup(inFlight, { pending, exit: () => {}, setExitCode: () => {}, stdin });
    stdin.emit("end");
    assert.ok(await waitUntil(() => !isAlive(pids[0])), "the task's agent outlived the shutdown");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    await raw.close();
  }
});

test("a delegation that fails after its prompt completes its task with the error result", async () => {
  const runDelegate = async ({ onSessionReady, onPromptSent }) => {
    onSessionReady("sess-fail", { cancel: async () => {}, stop: () => true });
    onPromptSent("sess-fail");
    await new Promise((r) => setTimeout(r, 50));
    throw Object.assign(new Error("agent died"), { reason: "agent-exit" });
  };
  const raw = await connectRaw({ runDelegate, tasks: createTaskStore() });
  try {
    const { result } = await raw.call().reply;
    const done = await waitForTask(raw, result.taskId);
    assert.equal(done.status, "completed");
    assert.equal(done.result.isError, true);
    assert.equal(done.result.content[0].text, "delegate failed [agent-exit]: agent died");
  } finally {
    await raw.close();
  }
});

test("tasks/cancel after the turn has ended leaves the task to complete", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let turnEnded;
  const ended = new Promise((r) => { turnEnded = r; });
  const runDelegate = async ({ onSessionReady, onPromptSent, onTurnEnd, signal }) => {
    onSessionReady("sess-ended", { cancel: async () => {}, stop: () => true });
    onPromptSent("sess-ended");
    onTurnEnd();
    turnEnded();
    await gate;
    return { result: "kept", sessionId: "sess-ended", aborted: signal.aborted };
  };
  const raw = await connectRaw({ runDelegate, tasks: createTaskStore() });
  try {
    const { result } = await raw.call().reply;
    await ended;
    await raw.send("tasks/cancel", { taskId: result.taskId }).reply;
    release();
    const done = await waitForTask(raw, result.taskId);
    assert.equal(done.status, "completed");
    assert.deepEqual(payload(done.result), { result: "kept", sessionId: "sess-ended", aborted: false });
  } finally {
    await raw.close();
  }
});

test("a 2025-era request that lists the tasks extension in _meta still gets a plain result", async () => {
  const runDelegate = async ({ onSessionReady, onPromptSent }) => {
    onSessionReady("sess-2025", { cancel: async () => {}, stop: () => true });
    onPromptSent?.("sess-2025");
    return { result: "plain", sessionId: "sess-2025" };
  };
  const { client, close } = await connectEra(undefined, { runDelegate, tasks: createTaskStore() });
  try {
    const res = await client.callTool({
      name: "delegate",
      arguments: { workspace: process.cwd(), spec: "x" },
      _meta: {
        [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION]: {} } },
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      },
    });
    assert.equal(payload(res).result, "plain");
  } finally {
    await close();
  }
});

test("a finished delegation does not evict a concurrent one holding the same session id", async () => {
  // A resume can race the turn it resumes, so two live delegations can share a session id.
  // The one that finishes first must not deregister the other — cancel then reported a
  // running session as already ended.
  const inFlight = new Map();
  const seenSessions = new Set();
  const mkDelegate = (delayMs) => async ({ onSessionReady }) => {
    onSessionReady("sess-shared", { cancel: async () => {}, stop: () => {} });
    await new Promise((r) => setTimeout(r, delayMs));
    return { result: "ok", sessionId: "sess-shared" };
  };
  const args = { spec: "task", mode: "agent", model: DEFAULT_MODEL, fast: false };
  const slow = runDelegateTool({ args, ctx: {}, runDelegate: mkDelegate(300), inFlight, seenSessions });
  const quick = runDelegateTool({ args, ctx: {}, runDelegate: mkDelegate(25), inFlight, seenSessions });

  await quick;
  assert.equal(inFlight.has("sess-shared"), true, "the still-running delegation must stay registered");
  await slow;
  assert.equal(inFlight.has("sess-shared"), false, "the last one out clears the entry");
});

test("runDelegateTool cleans up inFlight and returns isError when runDelegate throws", async () => {
  const inFlight = new Map();
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-x", { cancel: async () => {} });
    throw new Error("boom");
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /delegate failed: boom/);
  assert.equal(inFlight.has("sess-x"), false);
});

test("runDelegateTool tags a failure with its reason so callers need not parse prose", async () => {
  const runDelegate = async () => {
    const err = new Error("Session hard-cap exceeded after 400ms");
    err.reason = "hard-cap";
    throw err;
  };
  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    runDelegate,
    inFlight: new Map(),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^delegate failed \[hard-cap\]: Session hard-cap exceeded/);
});

test('runDelegateTool passes fast through to runDelegate unchanged (post-zod-default value)', async () => {
  const inFlight = new Map();
  let capturedArgs;
  const runDelegate = async (args) => {
    capturedArgs = args;
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-y", filesReportedByEditTools: [] };
  };

  await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5", fast: false },
    runDelegate,
    inFlight,
  });

  assert.equal(capturedArgs.fast, false);
});

test('delegate tool rejects empty model before runDelegate is called', async () => {
  let called = false;
  const runDelegate = async () => {
    called = true;
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-empty-model", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", mode: "agent", model: "" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /model must be a non-empty string/);
    assert.equal(called, false);
  } finally {
    await client.close();
  }
});

test('delegate tool trims whitespace from model before runDelegate', async () => {
  const captured = [];
  const runDelegate = async (args) => {
    captured.push(args);
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-trim-model", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", mode: "agent", model: "  composer-2.5  " } });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, "composer-2.5");
  } finally {
    await client.close();
  }
});

test('delegate tool defaults model to composer-2.5 when omitted', async () => {
  const captured = [];
  const runDelegate = async (args) => {
    captured.push(args);
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-default-model", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", mode: "agent" } });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, "composer-2.5");
  } finally {
    await client.close();
  }
});

test('delegate tool defaults fast to false end-to-end when the caller omits it', async () => {
  const captured = [];
  const runDelegate = async (args) => {
    captured.push(args);
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-z", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "x", mode: "agent", model: "composer-2.5" } });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].fast, false);
  } finally {
    await client.close();
  }
});

test("server advertises instructions, output schemas, and conservative tool annotations", async () => {
  const server = buildServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    // SEP-973 icons on initialize must match the registry listing — HTTPS URLs, not file://.
    // SDK 1.23.0 (the declared minimum) strips `theme` when parsing initialize; newer SDKs keep it.
    const registry = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    const advertised = client.getServerVersion();
    assert.equal(advertised.name, "cursor-delegate-mcp");
    assert.equal(advertised.version, registry.version);
    assert.equal(advertised.icons.length, registry.icons.length);
    for (const [i, icon] of advertised.icons.entries()) {
      const listed = registry.icons[i];
      assert.equal(icon.src, listed.src);
      assert.equal(icon.mimeType, listed.mimeType);
      assert.deepEqual(icon.sizes, listed.sizes);
      if (icon.theme !== undefined) assert.equal(icon.theme, listed.theme);
    }
    // Assert the invariants a host cannot infer, not the prose carrying them: hosts that
    // never load the skill see only this string.
    const instructions = client.getInstructions();
    assert.match(instructions, /auto-approved, in every mode/);
    assert.match(instructions, /review the git diff after every run/);
    assert.match(instructions, /filesReportedByEditTools/);
    const listed = await client.listTools();
    const tools = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(tools).sort(), ["cancel", "delegate", "doctor"]);
    // The description is what a host reads immediately before calling, so it must not
    // reassert the workspace confinement the instructions just denied.
    assert.match(tools.delegate.description, /every permission the agent requests, in any mode and anywhere on disk/i);
    // Elicitation never fires (cursor-agent keeps AskQuestion off ACP), so the description
    // must teach prose-question → resume, not sell elicitation.
    assert.match(tools.delegate.description, /Clarifying questions arrive as prose.*resumeSessionId/i);
    assert.ok(!/uses MCP elicitation/i.test(tools.delegate.description));
    assert.ok(tools.delegate.description.includes(DEFAULT_MODEL));
    assert.equal(delegateInputSchema.parse({ spec: "x", workspace: "." }).model, DEFAULT_MODEL);
    assert.equal(delegateInputSchema.parse({ spec: "x", workspace: ".", effort: "  xhigh  " }).effort, "xhigh");
    // Required, not defaulted: the server's own cwd under npx or a plugin launch is a cache
    // directory or the user's home, and a defaulted workspace sent the agent there.
    assert.ok(!delegateInputSchema.safeParse({ spec: "x" }).success);
    assert.ok(!delegateInputSchema.safeParse({ spec: "x", workspace: "   " }).success);
    const effortDescription = tools.delegate.inputSchema.properties.effort.description;
    assert.match(effortDescription, /Exact Cursor thinking-effort value/);
    assert.match(effortDescription, /invalid values fail before the prompt/);
    assert.match(effortDescription, /host's own reasoning setting is unrelated/);
    assert.doesNotMatch(effortDescription, /gpt-5\.x|extra-high/);
    // No outputSchema on any tool: declaring one forces structuredContent alongside the text
    // block, which puts the payload in the caller's context twice.
    assert.equal(tools.delegate.outputSchema, undefined);
    assert.equal(tools.doctor.outputSchema, undefined);
    assert.equal(tools.cancel.outputSchema, undefined);
    // With the schema gone, the description is the only published source of cancel's statuses.
    for (const status of ["cancelled", "killed", "not-running", "not-found"]) {
      assert.ok(tools.cancel.description.includes(status), `cancel description names ${status}`);
    }
    assert.equal(tools.delegate.annotations.readOnlyHint, false);
    assert.equal(tools.delegate.annotations.destructiveHint, true);
    assert.equal(tools.delegate.annotations.idempotentHint, false);
    assert.equal(tools.delegate.annotations.openWorldHint, true);
    assert.equal(tools.doctor.annotations.readOnlyHint, true);
    assert.equal(tools.cancel.annotations.idempotentHint, true);
  } finally {
    await client.close();
  }
});

test("runDelegateTool sends progress notifications when progressToken is set", async () => {
  const inFlight = new Map();
  const notifications = [];
  const ctx = { mcpReq: {
    _meta: { progressToken: "tok-1" },
    notify: (n) => { notifications.push(n); },
  } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-p", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-p", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    ctx,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  // The first notification surfaces the session id (for a mid-run cancel), then "tick".
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].method, "notifications/progress");
  assert.equal(notifications[0].params.progressToken, "tok-1");
  assert.equal(notifications[0].params.progress, 1);
  assert.match(notifications[0].params.message, /^session ready: sess-p$/);
  assert.equal(notifications[1].params.progress, 2);
  assert.equal(notifications[1].params.message, "tick");
});

test("runDelegateTool skips progress notifications when progressToken is absent", async () => {
  const inFlight = new Map();
  let notifyCalls = 0;
  const ctx = { mcpReq: { notify: () => { notifyCalls++; } } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-q", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-q", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    ctx,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(notifyCalls, 0);
  assert.equal(payload(result).result, "ok");
});

test("runDelegateTool survives notify failures", async () => {
  const inFlight = new Map();
  const ctx = { mcpReq: {
    _meta: { progressToken: "tok-1" },
    notify: () => { throw new Error("notify failed"); },
  } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-r", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-r", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    ctx,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(payload(result).result, "ok");
});

// The sync-throwing stub above never exercised the path that fails: the SDK declares
// notify async, and a rejection settles outside the try. The assertion is the absence
// of an unhandledRejection, not the return value.
test("runDelegateTool survives async notify rejections", async () => {
  const inFlight = new Map();
  const ctx = { mcpReq: {
    _meta: { progressToken: "tok-1" },
    notify: async () => { throw new Error("Not connected"); },
  } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-s", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-s", filesReportedByEditTools: [] };
  };

  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await runDelegateTool({
      args: { spec: "test", mode: "agent", model: "composer-2.5" },
      ctx,
      runDelegate,
      inFlight,
    });
    // A rejection queued by the notification settles on a later microtask than the tool result.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.isError, undefined);
    assert.equal(payload(result).result, "ok");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(rejections, []);
});

test("cancel tool cancels an in-flight delegation and cleans up", async () => {
  let cancelledWith;
  let release;
  const gate = new Promise((r) => { release = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-live", {
      cancel: async (sid) => { cancelledWith = sid; release(); },
    });
    sessionReady();
    await gate;
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-live", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    const cancelRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-live" } });
    assert.deepEqual(payload(cancelRes), { status: "cancelled", sessionId: "sess-live" });
    assert.equal(cancelledWith, "sess-live");
    const delegateRes = await delegateP;
    assert.notEqual(delegateRes.isError, true);
    assert.equal(payload(delegateRes).cancelRequested, true);
    const again = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-live" } });
    assert.equal(payload(again).status, "not-running");
    assert.deepEqual(payload(again), { status: "not-running", sessionId: "sess-live" });
  } finally {
    await client.close();
  }
});

test("cancel tool with force kills the agent when delegation does not settle", async () => {
  let cancelledWith;
  let stopCalled = false;
  let releaseStop;
  const gate = new Promise((r) => { releaseStop = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-force-kill", {
      cancel: async (sid) => { cancelledWith = sid; },
      stop: () => { stopCalled = true; releaseStop(); return true; },
    });
    sessionReady();
    await gate;
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-force-kill", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 50 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    const cancelRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-force-kill", force: true } });
    assert.equal(payload(cancelRes).status, "killed");
    assert.deepEqual(payload(cancelRes), { status: "killed", sessionId: "sess-force-kill" });
    assert.equal(cancelledWith, "sess-force-kill");
    assert.equal(stopCalled, true);
    const delegateRes = await delegateP;
    assert.notEqual(delegateRes.isError, true);
    assert.equal(payload(delegateRes).cancelRequested, true);
  } finally {
    await client.close();
  }
});

test("a force cancel does not kill a resume that registered during its grace", async () => {
  const stops = [];
  const release = {};
  let cancelSeen;
  const seen = new Promise((r) => { cancelSeen = r; });
  let resumeReady;
  const resumed = new Promise((r) => { resumeReady = r; });
  let firstReady;
  const first = new Promise((r) => { firstReady = r; });
  let calls = 0;
  const runDelegate = async ({ onSessionReady }) => {
    const n = ++calls;
    const gate = new Promise((r) => { release[n] = r; });
    onSessionReady("sess-shared", {
      cancel: async () => { cancelSeen(); },
      stop: () => { stops.push(n); release[n](); return true; },
    });
    (n === 1 ? firstReady : resumeReady)();
    await gate;
    return { result: `turn ${n}`, sessionId: "sess-shared" };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 300 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const firstP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    await first;
    const cancelP = client.callTool({ name: "cancel", arguments: { sessionId: "sess-shared", force: true } });
    await seen;
    const resumeP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "more", resumeSessionId: "sess-shared" } });
    await resumed;
    assert.equal(payload(await cancelP).status, "killed");
    assert.deepEqual(stops, [1], "only the turn the cancel named is stopped");
    release[2]();
    await firstP;
    assert.equal(payload(await resumeP).cancelRequested, undefined, "the resume was not cancelled");
  } finally {
    await client.close();
  }
});

test("a plain cancel keeps the session cancellable, so force still escalates", async () => {
  let stopCalled = false;
  let releaseStop;
  const gate = new Promise((r) => { releaseStop = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    // An agent that ignores session/cancel: the turn keeps running after the plain cancel.
    onSessionReady("sess-escalate", {
      cancel: async () => {},
      stop: () => { stopCalled = true; releaseStop(); return true; },
    });
    sessionReady();
    await gate;
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-escalate", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 50 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    const first = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate" } });
    assert.equal(payload(first).status, "cancelled");
    // Second, plain: the turn is still in flight, so this must not report not-found.
    const second = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate" } });
    assert.equal(payload(second).status, "cancelled");
    const escalated = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate", force: true } });
    assert.equal(payload(escalated).status, "killed");
    assert.equal(stopCalled, true);
    const delegateRes = await delegateP;
    assert.equal(payload(delegateRes).cancelRequested, true);
  } finally {
    await client.close();
  }
});

// stop() resolves false when the kill was dispatched and no exit followed. Reporting that as
// killed would tell the caller the agent is gone while it is still running and still holding
// the workspace.
test("force cancel reports cancelled and keeps the handle when no exit follows the kill", async () => {
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  let releaseTurn;
  const gate = new Promise((r) => { releaseTurn = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-stubborn", { cancel: async () => {}, stop: async () => false });
    sessionReady();
    await gate;
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-stubborn", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 50 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "long task" } });
    await ready;
    const first = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-stubborn", force: true } });
    assert.equal(payload(first).status, "cancelled");
    // Still registered, so the caller can force again instead of being told the id is unknown.
    const second = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-stubborn", force: true } });
    assert.equal(payload(second).status, "cancelled");
    releaseTurn();
    await delegateP;
  } finally {
    await client.close();
  }
});

test("force cancel does not untrack a resume that registers during stop()", async () => {
  let calls = 0;
  let firstReady, secondReady, firstRelease, secondRelease, enteredStop;
  const ready1 = new Promise((r) => { firstReady = r; });
  const ready2 = new Promise((r) => { secondReady = r; });
  const gate1 = new Promise((r) => { firstRelease = r; });
  const gate2 = new Promise((r) => { secondRelease = r; });
  const inStop = new Promise((r) => { enteredStop = r; });
  let resumeStopCalled = false;
  const runDelegate = async ({ onSessionReady }) => {
    calls++;
    if (calls === 1) {
      onSessionReady("sess-race", {
        cancel: async () => {},
        stop: async () => {
          enteredStop();
          await new Promise((r) => setTimeout(r, 80));
          return true;
        },
      });
      firstReady();
      await gate1;
      return { result: "one", sessionId: "sess-race" };
    }
    onSessionReady("sess-race", {
      cancel: async () => {},
      stop: async () => { resumeStopCalled = true; return true; },
    });
    secondReady();
    await gate2;
    return { result: "two", sessionId: "sess-race" };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 20 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const firstP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "first turn" } });
    await ready1;
    const cancelP = client.callTool({ name: "cancel", arguments: { sessionId: "sess-race", force: true } });
    await inStop;
    const secondP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "resume turn" } });
    await ready2;
    const killed = await cancelP;
    assert.equal(payload(killed).status, "killed");
    const still = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-race" } });
    assert.equal(payload(still).status, "cancelled", "the resume must still be in flight");
    assert.equal(resumeStopCalled, false);
    firstRelease();
    secondRelease();
    await firstP;
    await secondP;
  } finally {
    await client.close();
  }
});

test("a turn that ends during the force grace is left to its own teardown, not killed by the cancel", async () => {
  let endTurn;
  const cancelled = new Promise((r) => { endTurn = r; });
  let finishTeardown;
  const teardown = new Promise((r) => { finishTeardown = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  let stops = 0;
  const runDelegate = async ({ onSessionReady, onTurnEnd }) => {
    onSessionReady("sess-grace-end", { cancel: async () => { endTurn(); }, stop: () => { stops++; return true; } });
    sessionReady();
    await cancelled;
    onTurnEnd?.();
    // Teardown outlasts the grace, so the handle is still registered when the grace ends.
    await teardown;
    return { result: "done", sessionId: "sess-grace-end" };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 100 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    await ready;
    const res = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-grace-end", force: true } });
    assert.deepEqual(payload(res), { status: "cancelled", sessionId: "sess-grace-end" });
    assert.equal(stops, 0, "the cancel must not stop an agent its own teardown is stopping");
    finishTeardown();
    await delegateP;
  } finally {
    await client.close();
  }
});

test("a cancel while an ended turn's agent is stopped reports not-running and leaves the result alone", async () => {
  let finishTeardown;
  const teardown = new Promise((r) => { finishTeardown = r; });
  let turnEnded;
  const ended = new Promise((r) => { turnEnded = r; });
  let stops = 0;
  const runDelegate = async ({ onSessionReady, onTurnEnd }) => {
    onSessionReady("sess-ending", { cancel: async () => {}, stop: () => { stops++; return true; } });
    onTurnEnd?.();
    turnEnded();
    await teardown;
    return { result: "done", sessionId: "sess-ending" };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 100 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    await ended;
    for (const force of [false, true]) {
      const res = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-ending", force } });
      assert.deepEqual(payload(res), { status: "not-running", sessionId: "sess-ending" }, `force: ${force}`);
    }
    assert.equal(stops, 0, "the delegation's own teardown stops its agent");
    finishTeardown();
    assert.equal(payload(await delegateP).cancelRequested, undefined);
  } finally {
    await client.close();
  }
});

test("cancel tool with force returns cancelled when delegation settles during grace", async () => {
  let settleDuringGrace;
  const gate = new Promise((r) => { settleDuringGrace = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  let stopCalled = false;
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-force-settle", {
      cancel: async () => { settleDuringGrace(); },
      stop: () => { stopCalled = true; },
    });
    sessionReady();
    await gate;
    return { result: "done", stopReason: "end_turn", sessionId: "sess-force-settle", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 50 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    await ready;
    const cancelRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-force-settle", force: true } });
    assert.equal(payload(cancelRes).status, "cancelled");
    assert.deepEqual(payload(cancelRes), { status: "cancelled", sessionId: "sess-force-settle" });
    assert.equal(stopCalled, false);
    const delegateRes = await delegateP;
    assert.notEqual(delegateRes.isError, true);
    assert.equal(payload(delegateRes).cancelRequested, true);
  } finally {
    await client.close();
  }
});

test("cancel force kills a real stub agent whose prompt never finishes", async () => {
  // The live MCP host serializes tool calls, so force-kill can only be exercised here: a real
  // AcpClient drives infinite-stream-stub.js (handshakes, then streams forever), and the
  // non-serializing InMemoryTransport lets cancel run while delegate is in flight.
  const runDelegate = (opts) => realRunDelegate({
    ...opts,
    clientFactory: stubClientFactory("infinite-stream-stub.js"),
    idleMs: 0,          // no idle timeout — the stub streams steadily
    hardCapMs: 60000,   // far beyond the test, so the kill is what ends the turn
    handshakeMs: 10000,
  });
  const server = buildServer({ runDelegate, forceGraceMs: 100 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "stream forever" } });
    // Poll a plain cancel until the session registers (not-found → cancelled).
    const started = Date.now();
    let registered = false;
    while (Date.now() - started < 8000) {
      const probe = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-infinite" } });
      if (payload(probe).status !== "not-found") { registered = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(registered, "the stub session should register as in-flight");

    const killedAt = Date.now();
    const killRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-infinite", force: true } });
    assert.equal(payload(killRes).status, "killed");

    const delegateRes = await delegateP;
    assert.equal(delegateRes.isError, true);
    assert.match(delegateRes.content[0].text, /agent-exit/);
    assert.ok(Date.now() - killedAt < 10000, "the kill, not the 60s hard cap, ended the turn");
  } finally {
    await client.close();
  }
});

test("delegate output omits cancelRequested when no cancel was requested", async () => {
  const runDelegate = async () => ({
    result: "done",
    stopReason: "end_turn",
    sessionId: "sess-clean",
    filesReportedByEditTools: [],
  });
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "short task" } });
    assert.notEqual(res.isError, true);
    assert.equal("cancelRequested" in payload(res), false);
  } finally {
    await client.close();
  }
});

test("cancel tool reports unknown sessions without erroring", async () => {
  const server = buildServer({ runDelegate: async () => ({ result: "", stopReason: "end_turn", sessionId: "s", filesReportedByEditTools: [] }) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "cancel", arguments: { sessionId: "never-existed" } });
    assert.notEqual(res.isError, true);
    assert.equal(payload(res).status, "not-found");
    assert.deepEqual(payload(res), { status: "not-found", sessionId: "never-existed" });
  } finally {
    await client.close();
  }
});

test("cancel distinguishes a finished session (not-running) from an unknown id (not-found)", async () => {
  // A delegation that runs to completion, so its id is remembered but no longer in flight.
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-finished", { cancel: async () => {}, stop: () => {} });
    return { result: "done", stopReason: "end_turn", sessionId: "sess-finished", filesReportedByEditTools: [] };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateRes = await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    assert.notEqual(delegateRes.isError, true);

    const finished = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-finished" } });
    assert.equal(payload(finished).status, "not-running");

    const unknown = await client.callTool({ name: "cancel", arguments: { sessionId: "brand-new-uuid" } });
    assert.equal(payload(unknown).status, "not-found");
  } finally {
    await client.close();
  }
});

test("doctor tool passes deep and client info through to runDoctor", async () => {
  let captured;
  const runDoctor = async (opts) => {
    captured = opts;
    return {
      plugin: { version: "test" },
      client: {
        name: "doctor-test-client",
        version: "9.9",
        capabilities: {},
      },
      agent: { found: true, command: "cursor-agent acp", version: "fake-agent 2.0.0" },
      runtime: { node: "22.0.0", platform: "test", arch: "test", cwd: "/test", transport: "stdio" },
      env: {},
    };
  };
  const server = buildServer({ runDoctor });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "doctor-test-client", version: "9.9" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "doctor", arguments: { deep: true } });
    assert.equal(captured.deep, true);
    const info = captured.getClientInfo();
    assert.equal(info.version.name, "doctor-test-client");
    assert.equal(info.version.version, "9.9");
    assert.ok(info.capabilities, "expected client capabilities to be exposed");
    assert.equal(payload(res).runtime.transport, "stdio");
  } finally {
    await client.close();
  }
});

test("delegate tool call survives malformed ACP plan frames end-to-end", async () => {
  const { runDelegate } = await import("../src/delegate.js");
  const { EventEmitter } = await import("node:events");
  const clientFactory = () => {
    const acp = new EventEmitter();
    acp.start = async () => {};
    acp.initialize = async () => {};
    acp.newSession = async () => ({ sessionId: "sess-malformed" });
    acp.setModel = async () => {};
    acp.setConfigOption = async () => {};
    acp.setMode = async () => {};
    acp.prompt = async () => {
      acp.emit("update", { update: { sessionUpdate: "plan", entries: [{ content: { text: "not a string" } }] } });
      acp.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "implemented" } } });
      return { stopReason: "end_turn" };
    };
    acp.getTranscript = () => "";
    acp.stop = () => {};
    return acp;
  };
  const server = buildServer({
    runDelegate: (opts) => runDelegate({ ...opts, clientFactory }),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "malformed-plan-e2e", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "do the thing" } });
    assert.equal(res.isError ?? false, false, "completed work must not become an MCP error");
    const out = payload(res);
    assert.equal(out.result, "implemented");
    assert.equal(out.sessionId, "sess-malformed");
    assert.deepEqual(out.plan.entries, []);
    assert.match(out.protocolWarnings[0], /plan entry 0 dropped/);
  } finally {
    await client.close();
  }
});

// A detached agent no longer dies with a terminal signal to this process, so the handler is what
// keeps Ctrl-C from leaking one. win32 keeps the shared console group and installs nothing.
// Two turns: one for the settled kill's continuation, one for the exit it schedules off that
// continuation so the exit does not run on the settlement stack.
const flushExit = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test("installSignalCleanup stops registered agents, then exits", { skip: process.platform === "win32" }, async () => {
  const stopped = [];
  const exited = [];
  const map = new Map([["sess-1", new Set([{ client: { stop: () => { stopped.push("sess-1"); return Promise.resolve(true); } } }])]]);
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code) });
    process.emit("SIGINT");
    assert.deepEqual(stopped, ["sess-1"], "the registered agent must be stopped");
    await flushExit();
    assert.deepEqual(exited, [130], "the handler must exit rather than swallow the signal");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});

// The Windows kill is a separate taskkill process: a server that exits before it walks the tree
// orphans the launcher and the agent below the shell wrapper. Exit waits for the dispatched
// stops to settle; stop() bounds itself, so the wait cannot hang. Driven through stdin because
// win32 installs no signal handlers.
test("installSignalCleanup waits for the kill to settle before exiting", async () => {
  const order = [];
  const exited = [];
  let settle;
  const stop = new Promise((r) => { settle = r; });
  const map = new Map([["sess-1", new Set([{ client: { stop: () => { order.push("stop"); return stop; } } }])]]);
  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(map, { exit: (code) => { order.push("exit"); exited.push(code); }, stdin });
    stdin.emit("end");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ["stop"], "exit must not land while the kill is still in flight");
    settle(true);
    await flushExit();
    assert.deepEqual(order, ["stop", "exit"], "exit must follow the settled kill");
    assert.deepEqual(exited, [0]);
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const removeAddedSignalListeners = (before) => {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!before[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
};

test("a signal after stdin closed sets the exit code and still waits for the kill", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  const exited = [];
  const codes = [];
  let settle;
  const stopped = new Promise((r) => { settle = r; });
  const map = new Map([["sess-1", new Set([{ client: { stop: () => stopped } }])]]);
  const stdin = new EventEmitter();
  const before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code), setExitCode: (code) => codes.push(code), stdin });
    stdin.emit("end");
    process.emit("SIGHUP");
    await flushExit();
    assert.deepEqual(exited, [], "exit must wait for the kill");
    assert.deepEqual(codes, [0, 129]);
    settle(true);
    await flushExit();
    assert.deepEqual(exited, [129]);
  } finally {
    removeAddedSignalListeners(before);
  }
});

test("SIGHUP stops registered agents, and the stdin EOF after it does not cut the wait short", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  const exited = [];
  let settle;
  const stopped = new Promise((r) => { settle = r; });
  const map = new Map([["sess-1", new Set([{ client: { stop: () => stopped } }])]]);
  const stdin = new EventEmitter();
  const before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code), setExitCode: () => {}, stdin });
    process.emit("SIGHUP");
    stdin.emit("end");
    await flushExit();
    assert.deepEqual(exited, [], "exit must wait for the kill");
    settle(true);
    await flushExit();
    assert.deepEqual(exited, [129]);
  } finally {
    removeAddedSignalListeners(before);
  }
});

test("a second signal during shutdown exits at once", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  const exited = [];
  const map = new Map([["sess-1", new Set([{ client: { stop: () => new Promise(() => {}) } }])]]);
  const before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code), setExitCode: () => {}, stdin: new EventEmitter() });
    process.emit("SIGTERM");
    process.emit("SIGINT");
    assert.deepEqual(exited, [130]);
  } finally {
    removeAddedSignalListeners(before);
  }
});

// The rejection a failed kill produces has to be observed here: an unhandled one exits the
// server on its own, before the dispatched work is done (the discipline ebe7eab established
// for the progress announcements).
test("a stop that rejects on shutdown still exits and raises no unhandled rejection", async () => {
  const exited = [];
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
  const map = new Map([["sess-1", new Set([{ client: { stop: () => Promise.reject(new Error("kill failed")) } }])]]);
  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code), stdin });
    stdin.emit("end");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(exited, [0], "a rejected kill must not gate the exit");
    assert.deepEqual(rejections, [], "the rejection must be observed, not unhandled");
  } finally {
    process.off("unhandledRejection", onRejection);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});

// The MCP stdio shutdown sequence is: close the server's stdin, wait for it to exit, then signal.
test("installSignalCleanup stops registered agents and exits when stdin closes", async () => {
  const stopped = [];
  const exited = [];
  const map = new Map([["sess-1", new Set([{ client: { stop: () => { stopped.push("sess-1"); return Promise.resolve(true); } } }])]]);
  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code), stdin });
    stdin.emit("end");
    assert.deepEqual(stopped, ["sess-1"], "the registered agent must be stopped");
    await flushExit();
    assert.deepEqual(exited, [0], "stdin EOF must exit rather than linger");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});

test("installSignalCleanup stops again an agent whose exit the first stop did not see, before exiting", async () => {
  const results = [false, true];
  let stops = 0;
  const exited = [];
  const map = new Map([["sess-1", new Set([{ client: { stop: async () => results[stops++] } }])]]);
  const stdin = new EventEmitter();
  const before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code), stdin });
    stdin.emit("end");
    await flushExit();
    assert.equal(stops, 2);
    assert.deepEqual(exited, [0]);
  } finally {
    removeAddedSignalListeners(before);
  }
});

test("a session still being resumed outlives an equally old one that was seen once", async () => {
  // The remembered-session history is what lets cancel tell a finished, resumable session from
  // an id that never existed. Ageing it on insertion order alone evicted the id the caller was
  // actively working with, because a resume onto it did not count as use. Driven through the
  // real tool, past the real cap, so it measures the history rather than a copy of it.
  const runDelegate = async ({ resumeSessionId, onSessionReady }) => {
    const sessionId = resumeSessionId || `s-${Math.random().toString(36).slice(2)}`;
    onSessionReady?.(sessionId, { stop: () => Promise.resolve(true) });
    return { result: "ok", sessionId };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const delegate = (args) =>
    client.callTool({ name: "delegate", arguments: { spec: "x", workspace: process.cwd(), ...args } });
  try {
    await delegate({ resumeSessionId: "hot" });
    for (let i = 0; i < 400; i++) await delegate({});
    // The resume is the use that should count. Everything after it is younger than "hot".
    await delegate({ resumeSessionId: "hot" });
    for (let i = 0; i < 200; i++) await delegate({});

    const res = payload(await client.callTool({ name: "cancel", arguments: { sessionId: "hot" } }));
    assert.equal(res.status, "not-running", "a resumed session must not age out on insertion order");
  } finally {
    await client.close();
  }
});

test("shutdown records the exit code before it waits, and leaves the kill's own stack to exit", async () => {
  // Two separate facts. The code is set in the handler because a loop that runs dry on its own
  // still has to die with what the signal asked for, and the scheduled exit may never get a
  // turn. The exit is scheduled because running it on the settled kill's continuation puts
  // process teardown on that stack.
  const codes = [];
  const order = [];
  let settle;
  const stop = new Promise((r) => { settle = r; });
  const map = new Map([["sess-1", new Set([{ client: { stop: () => stop } }])]]);
  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(map, {
      exit: () => order.push("exit"),
      setExitCode: (code) => codes.push(code),
      schedule: (fn) => { order.push("scheduled"); setImmediate(fn); },
      stdin,
    });
    stdin.emit("end");
    // Synchronously, while the kill is still in flight.
    assert.deepEqual(codes, [0], "the exit code must be recorded before the wait, not after it");
    assert.deepEqual(order, [], "nothing may exit while the kill is outstanding");

    settle(true);
    await flushExit();
    assert.deepEqual(order, ["scheduled", "exit"], "the exit must go through the scheduler");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});

test("a shutdown during the handshake still kills the agent it spawned", async () => {
  // The agent process exists from client.start(); its session id arrives about 3.4s later. A
  // host going away inside that window used to exit with the agent running and nothing holding
  // it — it is registered by session id, and there is no session id yet. Real stub agent, real
  // process, and the assertion is that the pid is gone.
  const inFlight = new Map();
  const pending = new Set();
  let child;
  const started = new Promise((resolve) => {
    // The stub answers nothing, so the delegation sits in initialize for the whole test.
    setTimeout(function poll() {
      if (child?.pid) resolve();
      else setTimeout(poll, 20);
    }, 20);
  });

  const delegation = runDelegateTool({
    args: { spec: "x", mode: "agent", workspace: process.cwd(), model: "composer-2.5", fast: false },
    ctx: {},
    runDelegate: (opts) => realRunDelegate({
      ...opts,
      handshakeMs: 30000,
      clientFactory: (o) => {
        const client = stubClientFactory("handshake-hang-stub.js")(o);
        const start = client.start.bind(client);
        client.start = async () => { const r = await start(); child = client.child; return r; };
        return client;
      },
    }),
    inFlight,
    pending,
  });

  await started;
  const pid = child.pid;
  assert.equal(inFlight.size, 0, "no session id yet, so the map cannot hold it");
  assert.equal(pending.size, 1, "the handshake-stage delegation must still be reachable");

  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(inFlight, { pending, exit: () => {}, setExitCode: () => {}, stdin });
    stdin.emit("end");
    const deadline = Date.now() + 8000;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(), false, "the agent spawned during the handshake outlived the shutdown");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    await delegation.catch(() => {});
  }
});

// Force waited out the whole grace before looking, so a caller paid 5 s for a cancel that had
// already landed: 5011 ms live against cursor-agent on 2.8.0, with the shell command already gone.
test("cancel with force returns as soon as the turn settles, not after the whole grace", async () => {
  let settle;
  const gate = new Promise((r) => { settle = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-force-fast", { cancel: async () => { settle(); }, stop: () => {} });
    sessionReady();
    await gate;
    return { result: "", stopReason: "cancelled", sessionId: "sess-force-fast" };
  };
  const server = buildServer({ runDelegate, forceGraceMs: 5000 });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    await ready;
    const started = Date.now();
    const cancelRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-force-fast", force: true } });
    const elapsed = Date.now() - started;
    assert.equal(payload(cancelRes).status, "cancelled");
    assert.ok(elapsed < 1000, `force cancel took ${elapsed} ms for a turn that settled at once`);
    await delegateP;
  } finally {
    await client.close();
  }
});

test("the doctor tool registers its agent where shutdown looks, and passes the host's abort signal", async () => {
  const pending = new Set();
  let seen;
  const runDoctor = async ({ onClientReady, signal }) => {
    const client = { stop: () => true };
    onClientReady(client);
    seen = { registered: [...pending].some((h) => h.client === client), signal };
    return { plugin: { version: "x" }, client: { name: null, version: null, capabilities: {} }, agent: { found: true, command: "cursor-agent", version: null }, runtime: { node: "", platform: "", arch: "", cwd: "", transport: "stdio" }, env: {} };
  };
  const server = buildServer({ runDoctor, pending });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "doctor", arguments: { deep: true } });
    assert.equal(seen.registered, true, "shutdown must be able to reach doctor's agent");
    assert.ok(seen.signal instanceof AbortSignal, "the host's abort signal must reach doctor");
    assert.equal(pending.size, 0, "the handle is dropped once doctor returns");
  } finally {
    await client.close();
  }
});

test("cancel rejects a blank sessionId and trims one with stray whitespace", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let sessionReady;
  const ready = new Promise((r) => { sessionReady = r; });
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-padded", { cancel: async () => { release(); }, stop: () => true });
    sessionReady();
    await gate;
    return { result: "", sessionId: "sess-padded" };
  };
  const server = buildServer({ runDelegate });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const blank = await client.callTool({ name: "cancel", arguments: { sessionId: "  " } });
    assert.equal(blank.isError, true, JSON.stringify(blank));
    const delegateP = client.callTool({ name: "delegate", arguments: { workspace: process.cwd(), spec: "task" } });
    await ready;
    const padded = await client.callTool({ name: "cancel", arguments: { sessionId: " sess-padded\n" } });
    assert.deepEqual(payload(padded), { status: "cancelled", sessionId: "sess-padded" });
    assert.equal(payload(await delegateP).cancelRequested, true);
  } finally {
    await client.close();
  }
});
