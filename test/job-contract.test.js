import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  JOB_STATUSES,
  TERMINAL_STATUSES,
  isJobStatus,
  isTerminalJobStatus,
  jobIdSchema,
  publicJobSnapshot,
  waitInputSchema,
} from "../src/job-contract.js";
import { resolveJobRoot } from "../src/job-paths.js";

test("job statuses and terminal states are stable", () => {
  assert.deepEqual(JOB_STATUSES, [
    "queued",
    "starting",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  assert.deepEqual([...TERMINAL_STATUSES], [
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  for (const status of JOB_STATUSES) {
    assert.equal(isJobStatus(status), true);
    assert.equal(isTerminalJobStatus(status), TERMINAL_STATUSES.has(status));
  }
  assert.equal(isJobStatus("unknown"), false);
});

test("wait defaults to 20 seconds and is bounded at 30 seconds", () => {
  assert.deepEqual(waitInputSchema.parse({ jobId: "123e4567-e89b-42d3-a456-426614174000" }), {
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    timeoutMs: 20_000,
  });
  assert.equal(waitInputSchema.parse({
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    timeoutMs: 0,
  }).timeoutMs, 0);
  assert.equal(waitInputSchema.parse({
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    timeoutMs: 30_000,
  }).timeoutMs, 30_000);
  assert.throws(() => waitInputSchema.parse({
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    timeoutMs: 30_001,
  }));
});

test("job ids accept UUIDs and reject traversal or aliases", () => {
  assert.equal(jobIdSchema.parse("123e4567-e89b-42d3-a456-426614174000"),
    "123e4567-e89b-42d3-a456-426614174000");
  for (const value of ["../../escape", "not-a-uuid", "123e4567-e89b-12d3-a456-426614174000/child"]) {
    assert.throws(() => jobIdSchema.parse(value));
  }
});

test("job root follows the platform state directories and environment override", () => {
  assert.equal(resolveJobRoot({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    homeDir: "C:\\Users\\alice",
  }), path.win32.join("C:\\Users\\alice\\AppData\\Local", "cursor-delegate-mcp", "jobs"));
  assert.equal(resolveJobRoot({
    platform: "linux",
    env: { XDG_STATE_HOME: "/home/alice/.state" },
    homeDir: "/home/alice",
  }), path.posix.join("/home/alice/.state", "cursor-delegate-mcp", "jobs"));
  assert.equal(resolveJobRoot({
    platform: "linux",
    env: {},
    homeDir: "/home/alice",
  }), path.posix.join("/home/alice", ".local", "state", "cursor-delegate-mcp", "jobs"));
  assert.equal(resolveJobRoot({
    platform: "linux",
    env: { CURSOR_DELEGATE_STATE_DIR: "/var/tmp/delegate-state" },
    homeDir: "/home/alice",
  }), path.posix.join("/var/tmp/delegate-state", "jobs"));
});

test("public snapshots expose lifecycle metadata but not request contents", () => {
  const state = {
    jobId: "123e4567-e89b-42d3-a456-426614174000",
    status: "running",
    revision: 7,
    clientRequestId: "request-1",
    sessionId: "cursor-session",
    phase: "prompt",
    createdAt: "2026-11-06T00:00:00.000Z",
    startedAt: "2026-11-06T00:00:01.000Z",
    updatedAt: "2026-11-06T00:00:02.000Z",
    finishedAt: null,
    heartbeatAt: "2026-11-06T00:00:02.000Z",
    lastActivityAt: "2026-11-06T00:00:02.000Z",
    lastToolLabel: "Apply Patch",
    todoProgress: { total: 2, completed: 1 },
    filesReportedByEditTools: ["src/example.js"],
    cancelRequested: false,
    localTermination: "unknown",
    remoteTermination: "unknown",
    errorSummary: null,
    request: { spec: "private task text" },
    env: { TOKEN: "secret" },
  };

  const publicState = publicJobSnapshot(state);
  assert.equal(publicState.jobId, state.jobId);
  assert.equal(publicState.revision, 7);
  assert.equal(publicState.sessionId, "cursor-session");
  assert.equal(Object.hasOwn(publicState, "request"), false);
  assert.equal(Object.hasOwn(publicState, "env"), false);
  assert.equal(JSON.stringify(publicState).includes("private task text"), false);
});
