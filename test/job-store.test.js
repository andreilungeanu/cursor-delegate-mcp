import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendJobEvent,
  createJob,
  jobDirectory,
  readJobState,
  updateJobState,
  writeJobResultOnce,
} from "../src/job-store.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const jobId = "123e4567-e89b-42d3-a456-426614174000";

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("createJob persists the request and initial state atomically", async (t) => {
  const root = await makeRoot(t);
  const request = { spec: "do work", workspace: "C:\\work", mode: "agent" };
  const created = await createJob({
    root,
    jobId,
    request,
    now: () => "2026-11-06T00:00:00.000Z",
  });

  assert.equal(created.jobId, jobId);
  assert.equal(created.status, "queued");
  assert.equal(created.revision, 1);
  assert.equal(created.sessionId, null);
  assert.deepEqual(
    JSON.parse(await readFile(join(jobDirectory(root, jobId), "request.json"), "utf8")),
    request
  );
  assert.deepEqual(await readJobState(root, jobId), created);
});

test("concurrent state updates serialize and preserve a monotonic revision", async (t) => {
  const root = await makeRoot(t);
  await createJob({
    root,
    jobId,
    request: { spec: "work" },
    now: () => "2026-11-06T00:00:00.000Z",
  });

  await Promise.all(Array.from({ length: 20 }, (_, index) => updateJobState(
    root,
    jobId,
    (state) => ({ ...state, counter: (state.counter || 0) + 1, phase: `worker-${index}` })
  )));

  const state = await readJobState(root, jobId);
  assert.equal(state.counter, 20);
  assert.equal(state.revision, 21);
});

test("events are complete NDJSON lines and remain bounded", async (t) => {
  const root = await makeRoot(t);
  await createJob({ root, jobId, request: { spec: "work" } });
  for (let index = 0; index < 6; index++) {
    await appendJobEvent(root, jobId, {
      type: "progress",
      index,
      message: `message-${index}-${"x".repeat(60)}`,
    }, { maxBytes: 360 });
  }
  const body = await readFile(join(jobDirectory(root, jobId), "events.ndjson"), "utf8");
  const lines = body.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(Buffer.byteLength(body) <= 360);
  assert.equal(lines.at(-1).index, 5);
  assert.ok(lines.some((line) => line.type === "log-truncated"));
});

test("a result can be committed only once", async (t) => {
  const root = await makeRoot(t);
  await createJob({ root, jobId, request: { spec: "work" } });
  await writeJobResultOnce(root, jobId, { result: "ok", sessionId: "session-1" });
  await assert.rejects(
    writeJobResultOnce(root, jobId, { result: "replacement", sessionId: "session-2" }),
    (error) => error?.reason === "result-exists"
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(jobDirectory(root, jobId), "result.json"), "utf8")),
    { result: "ok", sessionId: "session-1" }
  );
});

test("corrupt state reports state-corrupt and preserves the original bytes", async (t) => {
  const root = await makeRoot(t);
  await createJob({ root, jobId, request: { spec: "work" } });
  const statePath = join(jobDirectory(root, jobId), "state.json");
  await writeFile(statePath, "{not json", "utf8");
  await assert.rejects(
    readJobState(root, jobId),
    (error) => error?.reason === "state-corrupt" && error.path === statePath
  );
  assert.equal(await readFile(statePath, "utf8"), "{not json");
});

test("job paths reject non-UUID identifiers", async (t) => {
  const root = await makeRoot(t);
  assert.throws(() => jobDirectory(root, "../../escape"));
});

test("POSIX state files use private permissions", {
  skip: process.platform === "win32" ? "POSIX file modes" : false,
}, async (t) => {
  const root = await makeRoot(t);
  await createJob({ root, jobId, request: { spec: "work" } });
  const directoryMode = (await stat(jobDirectory(root, jobId))).mode & 0o777;
  const stateMode = (await stat(join(jobDirectory(root, jobId), "state.json"))).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(stateMode, 0o600);
});
