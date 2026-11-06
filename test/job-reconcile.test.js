import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJob,
  jobDirectory,
  readJobState,
  updateJobState,
} from "../src/job-store.js";
import { getJobStatus } from "../src/job-tools.js";
import { reconcileJob } from "../src/job-reconcile.js";

const nowMs = Date.parse("2026-11-06T00:10:00.000Z");
const now = () => "2026-11-06T00:10:00.000Z";

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createRunning(root, overrides = {}) {
  const created = await createJob({
    root,
    request: { spec: "work", workspace: root },
    now: () => "2026-11-06T00:09:00.000Z",
  });
  await updateJobState(root, created.jobId, (state) => ({
    ...state,
    status: "running",
    sessionId: "session-reconcile",
    runnerPid: 4242,
    spawnAttemptedAt: "2026-11-06T00:09:00.000Z",
    heartbeatAt: "2026-11-06T00:09:00.000Z",
    updatedAt: "2026-11-06T00:09:00.000Z",
    ...overrides,
  }), { now: () => "2026-11-06T00:09:00.000Z" });
  return created;
}

test("fresh heartbeat is not reconciled", async (t) => {
  const root = await makeRoot(t);
  const created = await createRunning(root, { heartbeatAt: "2026-11-06T00:09:50.000Z" });
  const before = await readFile(join(jobDirectory(root, created.jobId), "state.json"), "utf8");
  const result = await reconcileJob({
    root,
    jobId: created.jobId,
    now,
    nowMs,
    isPidAlive: () => false,
  });
  assert.equal(result.changed, false);
  assert.equal(await readFile(join(jobDirectory(root, created.jobId), "state.json"), "utf8"), before);
});

test("an alive runner with a stale heartbeat is only derived stale", async (t) => {
  const root = await makeRoot(t);
  const created = await createRunning(root);
  const result = await reconcileJob({
    root,
    jobId: created.jobId,
    now,
    nowMs,
    isPidAlive: () => true,
  });
  assert.equal(result.changed, false);
  const status = await getJobStatus({
    root,
    jobId: created.jobId,
    now,
    nowMs,
    isPidAlive: () => true,
  });
  assert.equal(status.health, "stale");
  assert.equal(status.status, "running");
});

test("a dead runner is written as interrupted only after evidence", async (t) => {
  const root = await makeRoot(t);
  const created = await createRunning(root);
  const result = await reconcileJob({
    root,
    jobId: created.jobId,
    now,
    nowMs,
    isPidAlive: () => false,
  });
  assert.equal(result.changed, true);
  const state = await readJobState(root, created.jobId);
  assert.equal(state.status, "interrupted");
  assert.equal(state.localTermination, "unknown");
  assert.equal(state.remoteTermination, "unknown");
  const body = JSON.parse(
    await readFile(join(jobDirectory(root, created.jobId), "result.json"), "utf8")
  );
  assert.equal(body.status, "interrupted");
  assert.equal(body.reason, "runner-exited");
});

test("a stale queued job without a runner is interrupted", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({
    root,
    request: { spec: "work", workspace: root },
    now: () => "2026-11-06T00:09:00.000Z",
  });
  const result = await reconcileJob({
    root,
    jobId: created.jobId,
    now,
    nowMs,
    isPidAlive: () => false,
  });
  assert.equal(result.changed, true);
  const state = await readJobState(root, created.jobId);
  assert.equal(state.status, "interrupted");
  assert.equal(state.localTermination, "not-started");
  assert.equal(state.remoteTermination, "not-applicable");
});

test("concurrent reconcile has one writer and creates one result", async (t) => {
  const root = await makeRoot(t);
  const created = await createRunning(root);
  const results = await Promise.all(Array.from({ length: 10 }, () => reconcileJob({
    root,
    jobId: created.jobId,
    now,
    nowMs,
    isPidAlive: () => false,
  })));
  assert.equal(results.filter((result) => result.changed).length, 1);
  const state = await readJobState(root, created.jobId);
  assert.equal(state.revision, created.revision + 2);
});

test("corrupt state remains a state-corrupt error", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await writeFile(join(jobDirectory(root, created.jobId), "state.json"), "{broken", "utf8");
  await assert.rejects(
    reconcileJob({ root, jobId: created.jobId, now, nowMs }),
    (error) => error?.reason === "state-corrupt"
  );
});
