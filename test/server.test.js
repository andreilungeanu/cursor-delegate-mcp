import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AcpClient } from "../src/acp-client.js";
import { DEFAULT_MODEL, runDelegate as realRunDelegate } from "../src/delegate.js";
import { runDelegateTool, buildServer, delegateInputSchema } from "../src/server.js";

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

test("runDelegateTool cleans up inFlight and returns isError when runDelegate throws", async () => {
  const inFlight = new Map();
  const server = { server: {} };
  const runDelegate = async ({ onSessionReady }) => {
    onSessionReady("sess-x", { cancel: async () => {} });
    throw new Error("boom");
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    server,
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
    server: { server: {} },
    runDelegate,
    inFlight: new Map(),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^delegate failed \[hard-cap\]: Session hard-cap exceeded/);
});

test('runDelegateTool passes fast through to runDelegate unchanged (post-zod-default value)', async () => {
  const inFlight = new Map();
  const server = { server: {} };
  let capturedArgs;
  const runDelegate = async (args) => {
    capturedArgs = args;
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-y", filesReportedByEditTools: [] };
  };

  await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5", fast: false },
    server,
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
    assert.ok(tools.delegate.outputSchema);
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
  const server = { server: {} };
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
    server,
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
  const server = { server: {} };
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
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(notifyCalls, 0);
  assert.match(result.content[0].text, /"result": "ok"/);
});

test("runDelegateTool survives sendNotification failures", async () => {
  const inFlight = new Map();
  const server = { server: {} };
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
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /"result": "ok"/);
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
    assert.match(cancelRes.content[0].text, /^cancelled sess-live$/);
    assert.equal(cancelledWith, "sess-live");
    const delegateRes = await delegateP;
    assert.notEqual(delegateRes.isError, true);
    assert.equal(delegateRes.structuredContent.cancelRequested, true);
    const again = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-live" } });
    assert.equal(again.structuredContent.status, "not-running");
    assert.match(again.content[0].text, /^session sess-live is not running/);
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
      stop: () => { stopCalled = true; releaseStop(); },
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
    assert.equal(cancelRes.structuredContent.status, "killed");
    assert.match(cancelRes.content[0].text, /^killed sess-force-kill$/);
    assert.equal(cancelledWith, "sess-force-kill");
    assert.equal(stopCalled, true);
    const delegateRes = await delegateP;
    assert.notEqual(delegateRes.isError, true);
    assert.equal(delegateRes.structuredContent.cancelRequested, true);
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
      stop: () => { stopCalled = true; releaseStop(); },
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
    assert.equal(first.structuredContent.status, "cancelled");
    // Second, plain: the turn is still in flight, so this must not report not-found.
    const second = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate" } });
    assert.equal(second.structuredContent.status, "cancelled");
    const escalated = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-escalate", force: true } });
    assert.equal(escalated.structuredContent.status, "killed");
    assert.equal(stopCalled, true);
    const delegateRes = await delegateP;
    assert.equal(delegateRes.structuredContent.cancelRequested, true);
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
    assert.equal(cancelRes.structuredContent.status, "cancelled");
    assert.match(cancelRes.content[0].text, /^cancelled sess-force-settle$/);
    assert.equal(stopCalled, false);
    const delegateRes = await delegateP;
    assert.notEqual(delegateRes.isError, true);
    assert.equal(delegateRes.structuredContent.cancelRequested, true);
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
      if (probe.structuredContent.status !== "not-found") { registered = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(registered, "the stub session should register as in-flight");

    const killedAt = Date.now();
    const killRes = await client.callTool({ name: "cancel", arguments: { sessionId: "sess-infinite", force: true } });
    assert.equal(killRes.structuredContent.status, "killed");

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
    assert.equal("cancelRequested" in res.structuredContent, false);
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
    assert.equal(res.structuredContent.status, "not-found");
    assert.match(res.content[0].text, /^no in-flight session never-existed$/);
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
    assert.equal(finished.structuredContent.status, "not-running");

    const unknown = await client.callTool({ name: "cancel", arguments: { sessionId: "brand-new-uuid" } });
    assert.equal(unknown.structuredContent.status, "not-found");
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
      agent: { found: true },
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
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.runtime.transport, "stdio");
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
    assert.equal(res.structuredContent.result, "implemented");
    assert.equal(res.structuredContent.sessionId, "sess-malformed");
    assert.deepEqual(res.structuredContent.plan.entries, []);
    assert.match(res.structuredContent.protocolWarnings[0], /plan entry 0 dropped/);
  } finally {
    await client.close();
  }
});
