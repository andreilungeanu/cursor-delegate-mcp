import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AcpClient } from "../src/acp-client.js";
import { DEFAULT_MODEL, runDelegate as realRunDelegate } from "../src/delegate.js";
import { runDelegateTool, buildServer, delegateInputSchema, installSignalCleanup } from "../src/server.js";

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
  const slow = runDelegateTool({ args, extra: {}, runDelegate: mkDelegate(300), inFlight, seenSessions });
  const quick = runDelegateTool({ args, extra: {}, runDelegate: mkDelegate(25), inFlight, seenSessions });

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
    const res = await client.callTool({ name: "delegate", arguments: { spec: "x", mode: "agent", model: "" } });
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
    await client.callTool({ name: "delegate", arguments: { spec: "x", mode: "agent", model: "  composer-2.5  " } });
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
    await client.callTool({ name: "delegate", arguments: { spec: "x", mode: "agent" } });
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
    await client.callTool({ name: "delegate", arguments: { spec: "x", mode: "agent", model: "composer-2.5" } });
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
    assert.equal(delegateInputSchema.parse({ spec: "x" }).model, DEFAULT_MODEL);
    assert.equal(delegateInputSchema.parse({ spec: "x", effort: "  xhigh  " }).effort, "xhigh");
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
  const extra = {
    _meta: { progressToken: "tok-1" },
    sendNotification: (n) => { notifications.push(n); },
  };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-p", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-p", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    extra,
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
  const extra = { sendNotification: () => { notifyCalls++; } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-q", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-q", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    extra,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(notifyCalls, 0);
  assert.equal(payload(result).result, "ok");
});

test("runDelegateTool survives sendNotification failures", async () => {
  const inFlight = new Map();
  const extra = {
    _meta: { progressToken: "tok-1" },
    sendNotification: () => { throw new Error("notify failed"); },
  };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-r", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-r", filesReportedByEditTools: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    extra,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(payload(result).result, "ok");
});

// The sync-throwing stub above never exercised the path that fails: the SDK declares
// sendNotification async, and a rejection settles outside the try. The assertion is the absence
// of an unhandledRejection, not the return value.
test("runDelegateTool survives async sendNotification rejections", async () => {
  const inFlight = new Map();
  const extra = {
    _meta: { progressToken: "tok-1" },
    sendNotification: async () => { throw new Error("Not connected"); },
  };
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
      extra,
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
    const delegateP = client.callTool({ name: "delegate", arguments: { spec: "long task" } });
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
    const delegateP = client.callTool({ name: "delegate", arguments: { spec: "long task" } });
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
    const delegateP = client.callTool({ name: "delegate", arguments: { spec: "long task" } });
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
    const delegateP = client.callTool({ name: "delegate", arguments: { spec: "long task" } });
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
    const delegateP = client.callTool({ name: "delegate", arguments: { spec: "task" } });
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
    const delegateP = client.callTool({ name: "delegate", arguments: { spec: "stream forever" } });
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
    const res = await client.callTool({ name: "delegate", arguments: { spec: "short task" } });
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
    const delegateRes = await client.callTool({ name: "delegate", arguments: { spec: "task" } });
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
    const res = await client.callTool({ name: "delegate", arguments: { spec: "do the thing" } });
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
test("installSignalCleanup stops registered agents, then exits", { skip: process.platform === "win32" }, async () => {
  const stopped = [];
  const exited = [];
  const map = new Map([["sess-1", new Set([{ client: { stop: () => { stopped.push("sess-1"); return Promise.resolve(true); } } }])]]);
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code) });
    process.emit("SIGINT");
    assert.deepEqual(stopped, ["sess-1"], "the registered agent must be stopped");
    await new Promise((r) => setImmediate(r));
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
    await new Promise((r) => setImmediate(r));
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

test("a second trigger during the wait exits at once", async () => {
  const exited = [];
  const map = new Map([["sess-1", new Set([{ client: { stop: () => new Promise(() => {}) } }])]]);
  const stdin = new EventEmitter();
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    installSignalCleanup(map, { exit: (code) => exited.push(code), stdin });
    stdin.emit("end");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(exited, [], "first trigger waits for the kill");
    stdin.emit("end");
    assert.deepEqual(exited, [0], "second trigger skips the wait");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
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

// The MCP stdio shutdown sequence is: close the server's stdin, wait for it to exit, then
// signal. The SDK transport does not listen for EOF, so without this handler a host that shuts
// down politely leaves the server — and any delegation still running in it — alive.
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
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(exited, [0], "stdin EOF must exit rather than linger");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});
