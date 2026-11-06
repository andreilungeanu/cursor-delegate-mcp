import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, jobDirectory, updateJobState } from "../src/job-store.js";
import { getJobStatus, waitForJob } from "../src/job-tools.js";

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("status returns the public lifecycle snapshot", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({
    root,
    request: { spec: "private brief", workspace: root },
  });
  const status = await getJobStatus({ root, jobId: created.jobId });
  assert.equal(status.jobId, created.jobId);
  assert.equal(status.status, "queued");
  assert.equal(status.revision, 1);
  assert.equal(status.sessionId, null);
  assert.equal(status.health, "ok");
  assert.equal(Object.hasOwn(status, "request"), false);
  assert.equal(JSON.stringify(status).includes("private brief"), false);
});

test("status reports unknown ids as job-not-found", async (t) => {
  const root = await makeRoot(t);
  await assert.rejects(
    getJobStatus({ root, jobId: "123e4567-e89b-42d3-a456-426614174000" }),
    (error) => error?.reason === "job-not-found"
  );
});

test("wait wakes when the revision increases", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  const pending = waitForJob({
    root,
    jobId: created.jobId,
    afterRevision: created.revision,
    timeoutMs: 1_000,
    pollMs: 10,
  });
  setTimeout(() => {
    void updateJobState(root, created.jobId, (state) => ({
      ...state,
      phase: "changed",
    }));
  }, 30);
  const waited = await pending;
  assert.equal(waited.changed, true);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.job.phase, "changed");
  assert.ok(waited.job.revision > created.revision);
});

test("wait timeout is a normal result and does not mutate the job", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  const statePath = join(jobDirectory(root, created.jobId), "state.json");
  const before = await readFile(statePath, "utf8");
  const waited = await waitForJob({
    root,
    jobId: created.jobId,
    afterRevision: created.revision,
    timeoutMs: 30,
    pollMs: 5,
  });
  assert.equal(waited.changed, false);
  assert.equal(waited.timedOut, true);
  assert.equal(await readFile(statePath, "utf8"), before);
});

test("zero timeout returns the current snapshot without sleeping", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  const startedAt = Date.now();
  const waited = await waitForJob({
    root,
    jobId: created.jobId,
    afterRevision: created.revision,
    timeoutMs: 0,
  });
  assert.ok(Date.now() - startedAt < 100);
  assert.equal(waited.changed, false);
  assert.equal(waited.timedOut, true);
});

test("a terminal job is always a changed result", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await updateJobState(root, created.jobId, (state) => ({
    ...state,
    status: "failed",
    finishedAt: "2026-11-06T00:00:00.000Z",
  }));
  const waited = await waitForJob({
    root,
    jobId: created.jobId,
    afterRevision: 999,
    timeoutMs: 30,
  });
  assert.equal(waited.changed, true);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.job.status, "failed");
});
