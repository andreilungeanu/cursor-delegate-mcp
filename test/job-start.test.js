import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { claimClientRequest, claimSessionLock } from "../src/job-locks.js";
import {
  createJob,
  jobDirectory,
  readJobState,
  updateJobState,
} from "../src/job-store.js";
import { startPersistentJob } from "../src/job-tools.js";

const baseArgs = {
  spec: "do bounded work",
  workspace: process.cwd(),
};

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

test("start persists first and launches one detached runner in under five seconds", async (t) => {
  const root = await makeRoot(t);
  const calls = [];
  const startedAt = Date.now();
  const result = await startPersistentJob({
    root,
    args: { ...baseArgs, clientRequestId: "start-once" },
    spawn: (command, args, options) => {
      const child = fakeChild();
      calls.push({ command, args, options, child });
      return child;
    },
  });

  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(result.ok, true);
  assert.equal(result.job.status, "queued");
  assert.equal(result.job.sessionId, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.stdio[0], "ignore");
  assert.equal(calls[0].options.stdio[1] === "inherit", false);
  assert.equal(calls[0].options.stdio[2] === "inherit", false);
  assert.equal(calls[0].child.unrefCalled, true);
  assert.match(calls[0].args[0], /job-runner\.js$/);
  assert.equal(calls[0].args[1], root);
  assert.equal(calls[0].args[2], result.job.jobId);
  const state = await readJobState(root, result.job.jobId);
  assert.equal(state.runnerPid, 4242);
  assert.ok(state.runnerSpawnedAt);
});

test("same clientRequestId retry does not spawn a second runner", async (t) => {
  const root = await makeRoot(t);
  let spawnCount = 0;
  const request = { ...baseArgs, clientRequestId: "stable-start" };
  const first = await startPersistentJob({
    root,
    args: request,
    spawn: () => {
      spawnCount++;
      return fakeChild();
    },
  });
  const second = await startPersistentJob({
    root,
    args: request,
    spawn: () => {
      spawnCount++;
      return fakeChild(9999);
    },
  });
  assert.equal(first.job.jobId, second.job.jobId);
  assert.equal(spawnCount, 1);
  assert.equal((await readJobState(root, second.job.jobId)).runnerPid, 4242);
});

test("a different request with the same clientRequestId is rejected", async (t) => {
  const root = await makeRoot(t);
  await startPersistentJob({
    root,
    args: { ...baseArgs, clientRequestId: "conflict" },
    spawn: () => fakeChild(),
  });
  await assert.rejects(
    startPersistentJob({
      root,
      args: { ...baseArgs, spec: "different work", clientRequestId: "conflict" },
      spawn: () => fakeChild(),
    }),
    (error) => error?.reason === "idempotency-conflict"
  );
});

test("a resume session held by another active job is rejected before spawn", async (t) => {
  const root = await makeRoot(t);
  const holder = await createJob({
    root,
    request: { ...baseArgs, resumeSessionId: "session-held" },
  });
  await claimSessionLock({ root, sessionId: "session-held", jobId: holder.jobId });
  let spawned = false;
  const result = await startPersistentJob({
    root,
    args: { ...baseArgs, resumeSessionId: "session-held", clientRequestId: "busy-start" },
    spawn: () => {
      spawned = true;
      return fakeChild();
    },
  });

  assert.equal(spawned, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session-busy");
  assert.equal(result.holderJobId, holder.jobId);
  const resultBody = JSON.parse(
    await readFile(join(jobDirectory(root, result.jobId), "result.json"), "utf8")
  );
  assert.equal(resultBody.reason, "session-busy");
});

test("a persisted spawn intent prevents a duplicate after restart", async (t) => {
  const root = await makeRoot(t);
  const claimed = await claimClientRequest({
    root,
    clientRequestId: "spawn-window",
    request: baseArgs,
  });
  await updateJobState(root, claimed.job.jobId, (state) => ({
    ...state,
    spawnAttemptedAt: "2026-11-06T00:00:00.000Z",
    spawnToken: "already-attempted",
  }));
  let spawned = false;
  const result = await startPersistentJob({
    root,
    args: { ...baseArgs, clientRequestId: "spawn-window" },
    spawn: () => {
      spawned = true;
      return fakeChild();
    },
  });
  assert.equal(spawned, false);
  assert.equal(result.ok, true);
  assert.equal(result.job.jobId, claimed.job.jobId);
});

test("spawn failure writes a structured failed job", async (t) => {
  const root = await makeRoot(t);
  const result = await startPersistentJob({
    root,
    args: { ...baseArgs, clientRequestId: "spawn-fails" },
    spawn: () => {
      throw Object.assign(new Error("cannot launch"), { code: "ENOENT" });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "spawn-failed");
  const state = await readJobState(root, result.jobId);
  assert.equal(state.status, "failed");
  assert.equal(state.localTermination, "not-started");
  assert.equal(state.remoteTermination, "not-applicable");
});
