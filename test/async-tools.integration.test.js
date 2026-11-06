import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../src/server.js";

const jobId = "123e4567-e89b-42d3-a456-426614174000";
const payload = (result) => JSON.parse(result.content[0].text);

async function connected(overrides) {
  const server = buildServer(overrides);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "async-tool-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("start applies the delegate defaults and returns one JSON text block", async () => {
  let captured;
  const client = await connected({
    startJob: async ({ args }) => {
      captured = args;
      return {
        ok: true,
        job: {
          jobId,
          status: "queued",
          revision: 1,
          sessionId: null,
          clientRequestId: args.clientRequestId,
          createdAt: "2026-11-06T00:00:00.000Z",
        },
      };
    },
    jobRoot: () => "C:\\state",
  });
  try {
    const result = await client.callTool({
      name: "start",
      arguments: {
        workspace: process.cwd(),
        spec: "bounded task",
        clientRequestId: "request-1",
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.structuredContent, undefined);
    assert.equal(captured.mode, "agent");
    assert.equal(captured.model, "composer-2.5");
    assert.equal(captured.fast, false);
    assert.equal(payload(result).jobId, jobId);
    assert.equal(payload(result).status, "queued");
  } finally {
    await client.close();
  }
});

test("status, wait, and result expose their bounded contracts", async () => {
  const client = await connected({
    reconcileJob: async () => ({ changed: false }),
    statusJob: async () => ({
      jobId,
      status: "running",
      revision: 4,
      sessionId: "session-1",
      health: "ok",
    }),
    waitJob: async ({ timeoutMs }) => ({
      job: {
        jobId,
        status: "running",
        revision: 4,
        sessionId: "session-1",
        health: "ok",
      },
      changed: false,
      timedOut: true,
      timeoutMs,
    }),
    resultJob: async () => ({
      ready: false,
      status: "not-ready",
      job: { jobId, status: "running", revision: 4 },
    }),
    jobRoot: () => "C:\\state",
  });
  try {
    const status = await client.callTool({ name: "status", arguments: { jobId } });
    assert.equal(payload(status).revision, 4);
    assert.equal(payload(status).health, "ok");

    const waited = await client.callTool({ name: "wait", arguments: { jobId, afterRevision: 4 } });
    assert.equal(payload(waited).changed, false);
    assert.equal(payload(waited).timedOut, true);

    const result = await client.callTool({ name: "result", arguments: { jobId } });
    assert.equal(result.isError, undefined);
    assert.equal(payload(result).status, "not-ready");
  } finally {
    await client.close();
  }
});

test("result returns the immutable delegate payload after completion", async () => {
  const delegateResult = {
    result: "finished",
    sessionId: "session-done",
    status: "succeeded",
    jobId,
    lifecycle: {
      status: "succeeded",
      localTermination: "confirmed",
      remoteTermination: "unknown",
    },
  };
  const client = await connected({
    resultJob: async () => ({ ready: true, status: "succeeded", value: delegateResult }),
    jobRoot: () => "C:\\state",
  });
  try {
    const result = await client.callTool({ name: "result", arguments: { jobId } });
    assert.deepEqual(payload(result), delegateResult);
    assert.equal(result.content.length, 1);
    assert.equal(result.structuredContent, undefined);
  } finally {
    await client.close();
  }
});

test("job tool failures are structured isError responses", async () => {
  const client = await connected({
    startJob: async () => ({
      ok: false,
      jobId,
      reason: "session-busy",
      holderJobId: "123e4567-e89b-42d3-a456-426614174001",
      message: "session held",
    }),
    statusJob: async () => {
      throw Object.assign(new Error("missing"), { reason: "job-not-found" });
    },
    reconcileJob: async () => {
      throw Object.assign(new Error("missing"), { reason: "job-not-found" });
    },
    jobRoot: () => "C:\\state",
  });
  try {
    const start = await client.callTool({
      name: "start",
      arguments: { workspace: process.cwd(), spec: "task" },
    });
    assert.equal(start.isError, true);
    assert.match(start.content[0].text, /\[session-busy\]/);

    const status = await client.callTool({ name: "status", arguments: { jobId } });
    assert.equal(status.isError, true);
    assert.match(status.content[0].text, /\[job-not-found\]/);
  } finally {
    await client.close();
  }
});

test("status performs atomic reconcile before reading the snapshot", async () => {
  const calls = [];
  const client = await connected({
    reconcileJob: async ({ jobId }) => {
      calls.push(`reconcile:${jobId}`);
      return { changed: true };
    },
    statusJob: async ({ jobId }) => {
      calls.push(`status:${jobId}`);
      return { jobId, status: "interrupted", revision: 9, health: "terminal" };
    },
    jobRoot: () => "C:\\state",
  });
  try {
    const result = await client.callTool({ name: "status", arguments: { jobId } });
    assert.equal(payload(result).status, "interrupted");
    assert.deepEqual(calls, [`reconcile:${jobId}`, `status:${jobId}`]);
  } finally {
    await client.close();
  }
});

test("async tool schemas reject missing and out-of-range arguments", async () => {
  const client = await connected({ jobRoot: () => "C:\\state" });
  try {
    const missingWorkspace = await client.callTool({
      name: "start",
      arguments: { spec: "task" },
    });
    assert.equal(missingWorkspace.isError, true);
    assert.match(missingWorkspace.content[0].text, /workspace/i);

    const tooLong = await client.callTool({
      name: "wait",
      arguments: { jobId, timeoutMs: 30_001 },
    });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0].text, /30000|30,000|too_big/i);
  } finally {
    await client.close();
  }
});
