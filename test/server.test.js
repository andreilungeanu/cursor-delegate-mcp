import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runDelegateTool, buildServer } from "../src/server.js";

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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-y", touchedFiles: [], questionsAsked: [] };
  };

  await runDelegateTool({
    args: { spec: "test", mode: "agent", model: "composer-2.5", fast: false },
    server,
    runDelegate,
    inFlight,
  });

  assert.equal(capturedArgs.fast, false);
});

test('delegate tool defaults fast to false end-to-end when the caller omits it', async () => {
  const captured = [];
  const runDelegate = async (args) => {
    captured.push(args);
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-z", touchedFiles: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-p", touchedFiles: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-q", touchedFiles: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-r", touchedFiles: [], questionsAsked: [] };
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

test("runDelegateTool auto-answers clarifying questions when client lacks elicitation", async () => {
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-a", touchedFiles: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-b", touchedFiles: [], questionsAsked: [] };
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
    return { result: "ok", stopReason: "end_turn", sessionId: "sess-c", touchedFiles: [], questionsAsked: [] };
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
