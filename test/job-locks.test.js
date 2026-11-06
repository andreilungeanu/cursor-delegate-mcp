import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimClientRequest,
  claimSessionLock,
  releaseSessionLock,
} from "../src/job-locks.js";
import { createJob, updateJobState } from "../src/job-store.js";

const request = {
  spec: "implement a bounded change",
  workspace: "C:\\work",
};

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-locks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("same clientRequestId and normalized request return the same job", async (t) => {
  const root = await makeRoot(t);
  const first = await claimClientRequest({
    root,
    clientRequestId: "request-stable",
    request,
  });
  const second = await claimClientRequest({
    root,
    clientRequestId: "request-stable",
    request: {
      workspace: "C:\\work",
      spec: "implement a bounded change",
    },
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.jobId, first.job.jobId);
  const indexBody = await readFile(first.indexPath, "utf8");
  assert.equal(indexBody.includes(request.spec), false);
  assert.equal(indexBody.includes("secret"), false);
});

test("same clientRequestId with different normalized content reports a conflict", async (t) => {
  const root = await makeRoot(t);
  await claimClientRequest({
    root,
    clientRequestId: "request-stable",
    request,
  });
  await assert.rejects(
    claimClientRequest({
      root,
      clientRequestId: "request-stable",
      request: { ...request, mode: "plan" },
    }),
    (error) => error?.reason === "idempotency-conflict"
  );
});

test("twenty concurrent claims produce one job", async (t) => {
  const root = await makeRoot(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => claimClientRequest({
    root,
    clientRequestId: "request-race",
    request,
  })));
  assert.equal(new Set(results.map((result) => result.job.jobId)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
});

test("one active job holds a resume session exclusively", async (t) => {
  const root = await makeRoot(t);
  const first = await createJob({
    root,
    request: { ...request, resumeSessionId: "cursor-session-1" },
  });
  const second = await createJob({
    root,
    request: { ...request, resumeSessionId: "cursor-session-1", spec: "second work" },
  });

  const lock = await claimSessionLock({
    root,
    sessionId: "cursor-session-1",
    jobId: first.jobId,
  });
  assert.equal(lock.jobId, first.jobId);
  await assert.rejects(
    claimSessionLock({
      root,
      sessionId: "cursor-session-1",
      jobId: second.jobId,
      staleMs: 0,
    }),
    (error) => error?.reason === "session-busy" && error?.jobId === first.jobId
  );
});

test("a terminal holder releases its session for a later job", async (t) => {
  const root = await makeRoot(t);
  const first = await createJob({
    root,
    request: { ...request, resumeSessionId: "cursor-session-1" },
  });
  const second = await createJob({
    root,
    request: { ...request, resumeSessionId: "cursor-session-1", spec: "second work" },
  });
  await claimSessionLock({ root, sessionId: "cursor-session-1", jobId: first.jobId });
  await updateJobState(root, first.jobId, (state) => ({
    ...state,
    status: "succeeded",
    finishedAt: "2026-11-06T00:00:02.000Z",
  }));

  const claimed = await claimSessionLock({
    root,
    sessionId: "cursor-session-1",
    jobId: second.jobId,
  });
  assert.equal(claimed.jobId, second.jobId);
  await releaseSessionLock(root, "cursor-session-1", second.jobId);
});
