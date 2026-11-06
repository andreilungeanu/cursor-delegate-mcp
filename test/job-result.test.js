import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJob,
  jobDirectory,
  updateJobState,
  writeJobResultOnce,
} from "../src/job-store.js";
import { getJobResult } from "../src/job-tools.js";

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("successful result returns the delegate output and lifecycle metadata", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  const outcome = {
    result: "done",
    sessionId: "session-result",
    status: "succeeded",
    jobId: created.jobId,
    lifecycle: {
      status: "succeeded",
      localTermination: "confirmed",
      remoteTermination: "unknown",
    },
  };
  await writeJobResultOnce(root, created.jobId, outcome);
  await updateJobState(root, created.jobId, (state) => ({
    ...state,
    status: "succeeded",
    sessionId: "session-result",
    finishedAt: "2026-11-06T00:00:00.000Z",
  }));

  const result = await getJobResult({ root, jobId: created.jobId });
  assert.equal(result.ready, true);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.value, outcome);
});

test("a running job returns not-ready without an error", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await updateJobState(root, created.jobId, (state) => ({
    ...state,
    status: "running",
    sessionId: "session-running",
    heartbeatAt: new Date().toISOString(),
  }));
  const result = await getJobResult({ root, jobId: created.jobId });
  assert.equal(result.ready, false);
  assert.equal(result.status, "not-ready");
  assert.equal(result.job.status, "running");
  assert.equal(result.job.sessionId, "session-running");
});

test("failed, cancelled, and interrupted results keep their structured status", async (t) => {
  const root = await makeRoot(t);
  for (const status of ["failed", "cancelled", "interrupted"]) {
    const created = await createJob({ root, request: { spec: status, workspace: root } });
    const outcome = {
      status,
      jobId: created.jobId,
      reason: `${status}-reason`,
      message: `${status} message`,
      sessionId: "session-partial",
      localTermination: status === "interrupted" ? "unknown" : "confirmed",
      remoteTermination: "unknown",
    };
    await writeJobResultOnce(root, created.jobId, outcome);
    await updateJobState(root, created.jobId, (state) => ({
      ...state,
      status,
      sessionId: "session-partial",
      finishedAt: "2026-11-06T00:00:00.000Z",
    }));
    const result = await getJobResult({ root, jobId: created.jobId });
    assert.equal(result.ready, true);
    assert.equal(result.status, status);
    assert.deepEqual(result.value, outcome);
  }
});

test("an unknown job is an error", async (t) => {
  const root = await makeRoot(t);
  await assert.rejects(
    getJobResult({
      root,
      jobId: "123e4567-e89b-42d3-a456-426614174000",
    }),
    (error) => error?.reason === "job-not-found"
  );
});

test("a corrupt terminal result is never reported as success", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: { spec: "work", workspace: root } });
  await updateJobState(root, created.jobId, (state) => ({
    ...state,
    status: "succeeded",
    finishedAt: "2026-11-06T00:00:00.000Z",
  }));
  const resultPath = join(jobDirectory(root, created.jobId), "result.json");
  await writeFile(resultPath, "{\"result\":", "utf8");
  await assert.rejects(
    getJobResult({ root, jobId: created.jobId }),
    (error) => error?.reason === "result-corrupt" && error?.path === resultPath
  );
});
