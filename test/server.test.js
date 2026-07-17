import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_MODEL } from "../src/delegate.js";
import { runDelegateTool, buildServer, delegateInputSchema } from "../src/server.js";

test("runDelegateTool cleans up inFlight and returns isError when runDelegate throws", async () => {
  const inFlight = new Map();
  const server = { server: { elicitInput: async () => ({ action: "reject" }) } };
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

test('runDelegateTool passes fast through to runDelegate unchanged (post-zod-default value)', async () => {
  const inFlight = new Map();
  const server = { server: { elicitInput: async () => ({ action: "reject" }) } };
  let capturedArgs;
  const runDelegate = async (args) => {
    capturedArgs = args;
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-y", filesReportedByAgent: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-empty-model", filesReportedByAgent: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-trim-model", filesReportedByAgent: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-default-model", filesReportedByAgent: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-z", filesReportedByAgent: [], questionsAsked: [] };
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
    assert.match(client.getInstructions(), /review the git diff after every write-capable run/);
    assert.match(client.getInstructions(), /filesReportedByAgent lists the files the agent reported editing/);
    const listed = await client.listTools();
    const tools = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(tools).sort(), ["cancel", "delegate", "doctor"]);
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
  const server = { server: { elicitInput: async () => ({ action: "reject" }) } };
  const notifications = [];
  const extra = {
    _meta: { progressToken: "tok-1" },
    sendNotification: (n) => { notifications.push(n); },
  };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-p", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-p", filesReportedByAgent: [], questionsAsked: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    extra,
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(result.isError, undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "notifications/progress");
  assert.equal(notifications[0].params.progressToken, "tok-1");
  assert.equal(notifications[0].params.progress, 1);
  assert.equal(notifications[0].params.message, "tick");
});

test("runDelegateTool skips progress notifications when progressToken is absent", async () => {
  const inFlight = new Map();
  const server = { server: { elicitInput: async () => ({ action: "reject" }) } };
  let notifyCalls = 0;
  const extra = { sendNotification: () => { notifyCalls++; } };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-q", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-q", filesReportedByAgent: [], questionsAsked: [] };
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
  const server = { server: { elicitInput: async () => ({ action: "reject" }) } };
  const extra = {
    _meta: { progressToken: "tok-1" },
    sendNotification: () => { throw new Error("notify failed"); },
  };
  const runDelegate = async ({ onProgress, onSessionReady }) => {
    onSessionReady("sess-r", { cancel: async () => {} });
    onProgress("tick");
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-r", filesReportedByAgent: [], questionsAsked: [] };
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

test("runDelegateTool auto-answers clarifying questions by default when client lacks elicitation", async () => {
  const inFlight = new Map();
  const server = { server: { getClientCapabilities: () => ({}) } };
  let elicitCalls = 0;
  server.server.elicitInput = async () => { elicitCalls++; return { action: "accept", content: { choice: "x" } }; };
  let elicitOut;
  const runDelegate = async ({ onElicit }) => {
    elicitOut = await onElicit({
      title: "Pick one",
      questions: [{ id: "q1", prompt: "Which approach?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }],
    });
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-a", filesReportedByAgent: [], questionsAsked: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(elicitCalls, 0);
  assert.deepEqual(elicitOut, { answers: [{ questionId: "q1", selectedOptionIds: ["a"] }] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.autoAnswered, [{ prompt: "Which approach?", chosen: "Alpha" }]);
  assert.match(result.content[0].text, /"autoAnswered"/);
});

test("runDelegateTool uses elicitInput when client supports elicitation", async () => {
  const inFlight = new Map();
  let elicitCalls = 0;
  const server = {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => {
        elicitCalls++;
        return { action: "accept", content: { choice: "Beta" } };
      },
    },
  };
  let elicitOut;
  const runDelegate = async ({ onElicit }) => {
    elicitOut = await onElicit({
      questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }],
    });
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-b", filesReportedByAgent: [], questionsAsked: [] };
  };

  await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(elicitCalls, 1);
  assert.deepEqual(elicitOut, { answers: [{ questionId: "q1", selectedOptionIds: ["b"] }] });
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
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-live", filesReportedByAgent: [], questionsAsked: [] };
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
    assert.match(again.content[0].text, /^no in-flight session sess-live$/);
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
    return { result: "stopped", stopReason: "end_turn", sessionId: "sess-force-kill", filesReportedByAgent: [], questionsAsked: [] };
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
    return { result: "done", stopReason: "end_turn", sessionId: "sess-force-settle", filesReportedByAgent: [], questionsAsked: [] };
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

test("delegate output omits cancelRequested when no cancel was requested", async () => {
  const runDelegate = async () => ({
    result: "done",
    stopReason: "end_turn",
    sessionId: "sess-clean",
    filesReportedByAgent: [],
    questionsAsked: [],
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
  const server = buildServer({ runDelegate: async () => ({ result: "", stopReason: "end_turn", sessionId: "s", filesReportedByAgent: [], questionsAsked: [] }) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "cancel", arguments: { sessionId: "never-existed" } });
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /^no in-flight session never-existed$/);
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
        supportsElicitation: false,
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

test("runDelegateTool onElicit returns null when the user declines elicitation", async () => {
  const inFlight = new Map();
  const server = {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => ({ action: "decline" }),
    },
  };
  let elicitOut = "unset";
  const runDelegate = async ({ onElicit }) => {
    elicitOut = await onElicit({
      questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "Alpha" }] }],
    });
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-d", filesReportedByAgent: [], questionsAsked: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(elicitOut, null);
  assert.equal(result.structuredContent.autoAnswered, undefined);
  assert.equal(result.structuredContent.fallbackAnswers, undefined);
});

test("runDelegateTool answers multi-question elicitations, reporting only unmatched ones", async () => {
  const inFlight = new Map();
  const choices = ["Beta", "nothing like the options"];
  let elicitCalls = 0;
  const server = {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => ({ action: "accept", content: { choice: choices[elicitCalls++] } }),
    },
  };
  let elicitOut;
  const runDelegate = async ({ onElicit }) => {
    elicitOut = await onElicit({
      questions: [
        { id: "q1", prompt: "First?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
        { id: "q2", prompt: "Second?", options: [{ id: "x", label: "X-ray" }, { id: "y", label: "Yankee" }] },
      ],
    });
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-m", filesReportedByAgent: [], questionsAsked: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(elicitCalls, 2);
  assert.deepEqual(elicitOut, {
    answers: [
      { questionId: "q1", selectedOptionIds: ["b"] },
      { questionId: "q2", selectedOptionIds: ["x"] },
    ],
  });
  assert.deepEqual(result.structuredContent.fallbackAnswers, [
    { prompt: "Second?", given: "nothing like the options", chosen: "X-ray" },
  ]);
});

test("runDelegateTool reports fallbackAnswers when a free-text answer matches no option", async () => {
  const inFlight = new Map();
  const server = {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => ({ action: "accept", content: { choice: "something else entirely" } }),
    },
  };
  let elicitOut;
  const runDelegate = async ({ onElicit }) => {
    elicitOut = await onElicit({
      questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }],
    });
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-c", filesReportedByAgent: [], questionsAsked: [] };
  };

  const result = await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5" },
    server,
    runDelegate,
    inFlight,
  });

  assert.deepEqual(elicitOut, { answers: [{ questionId: "q1", selectedOptionIds: ["a"] }] });
  assert.deepEqual(result.structuredContent.fallbackAnswers, [
    { prompt: "Which?", given: "something else entirely", chosen: "Alpha" },
  ]);
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
    acp.setFast = async () => {};
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
