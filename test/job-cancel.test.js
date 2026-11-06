import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createJob,
  jobDirectory,
  readJobState,
  updateJobState,
} from "../src/job-store.js";
import { cancelPersistentJob } from "../src/job-tools.js";
import { runDelegationJob } from "../src/job-runner.js";

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("cancel persists an idempotent request for a running job", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await updateJobState(root, created.jobId, (state) => ({
    ...state,
    status: "running",
    sessionId: "session-cancel",
  }));
  const first = await cancelPersistentJob({ root, jobId: created.jobId, force: false });
  const afterFirst = await readJobState(root, created.jobId);
  const second = await cancelPersistentJob({ root, jobId: created.jobId, force: false });
  const afterSecond = await readJobState(root, created.jobId);
  assert.equal(first.status, "cancelling");
  assert.equal(second.status, "cancelling");
  assert.equal(afterFirst.cancelRequested, true);
  assert.equal(afterSecond.revision, afterFirst.revision);
});

test("force escalates an existing cancel request", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await cancelPersistentJob({ root, jobId: created.jobId, force: false });
  await cancelPersistentJob({ root, jobId: created.jobId, force: true });
  const cancel = JSON.parse(
    await readFile(join(jobDirectory(root, created.jobId), "cancel.json"), "utf8")
  );
  assert.equal(cancel.force, true);
});

test("a terminal job never has its result overwritten by cancel", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await updateJobState(root, created.jobId, (state) => ({
    ...state,
    status: "succeeded",
    finishedAt: "2026-11-06T00:00:00.000Z",
    localTermination: "confirmed",
  }));
  const result = await cancelPersistentJob({ root, jobId: created.jobId, force: true });
  assert.equal(result.status, "succeeded");
  await assert.rejects(access(join(jobDirectory(root, created.jobId), "cancel.json")));
});

test("runner observes force cancel, calls ACP cancel, and records cleanup", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const calls = [];
  const pending = runDelegationJob({
    root,
    jobId: created.jobId,
    cancelPollMs: 10,
    forceGraceMs: 10,
    runDelegate: async (options) => {
      const client = {
        cancel: async (sessionId) => { calls.push(`cancel:${sessionId}`); },
        stop: async () => {
          calls.push("stop");
          return true;
        },
      };
      options.onClientReady?.(client);
      options.onSessionReady?.("session-force", client);
      await options.beforePrompt({ sessionId: "session-force", client });
      ready();
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("delegation aborted");
          error.reason = "aborted";
          reject(error);
        }, { once: true });
      });
    },
  });
  await readyPromise;
  await cancelPersistentJob({ root, jobId: created.jobId, force: true });
  const outcome = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timeout")), 2_000)),
  ]);

  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.localTermination, "confirmed");
  assert.equal(outcome.remoteTermination, "unknown");
  assert.deepEqual(calls, ["cancel:session-force", "cancel:session-force", "stop"]);
  const state = await readJobState(root, created.jobId);
  assert.equal(state.status, "cancelled");
});

test("a cancel already persisted before runner start sends no prompt", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await cancelPersistentJob({ root, jobId: created.jobId, force: true });
  let delegateCalled = false;
  const outcome = await runDelegationJob({
    root,
    jobId: created.jobId,
    cancelPollMs: 10,
    runDelegate: async () => {
      delegateCalled = true;
      return { result: "unexpected", sessionId: "unexpected" };
    },
  });
  assert.equal(delegateCalled, false);
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.localTermination, "not-started");
  assert.equal(outcome.remoteTermination, "not-applicable");
});
