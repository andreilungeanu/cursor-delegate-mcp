import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createJob, jobDirectory, readJobState, updateJobState } from "../src/job-store.js";
import { claimSessionLock } from "../src/job-locks.js";
import { runDelegationJob } from "../src/job-runner.js";

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function request(resumeSessionId) {
  return {
    spec: "complete the bounded task",
    workspace: process.cwd(),
    mode: "agent",
    model: "composer-2.5",
    fast: false,
    resumeSessionId,
  };
}

test("runner persists session, progress, cleanup evidence, and one result", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: request() });
  const delegateCalls = [];
  const outcome = await runDelegationJob({
    root,
    jobId: created.jobId,
    heartbeatMs: 20,
    runDelegate: async (options) => {
      let client;
      const clientValue = {
        stop: async () => {
          delegateCalls.push("stop");
          return true;
        },
      };
      client = clientValue;
      options.onClientReady?.(client);
      options.onSessionReady?.("session-success", client);
      assert.equal(delegateCalls.includes("stop"), false, "client is not stopped before prompt");
      await options.beforePrompt({ sessionId: "session-success", client });
      options.onProgress?.("turn titled: Bounded work");
      options.onProgress?.("running: Edit File — src/example.js");
      options.onProgress?.("editing src/example.js");
      await new Promise((resolve) => setTimeout(resolve, 70));
      return {
        result: "finished",
        sessionId: "session-success",
        filesReportedByEditTools: ["src/example.js"],
        todoProgress: { total: 1, completed: 1, inProgress: 0, pending: 0, cancelled: 0 },
      };
    },
  });

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(delegateCalls, ["stop"]);
  const state = await readJobState(root, created.jobId);
  assert.equal(state.status, "succeeded");
  assert.equal(state.sessionId, "session-success");
  assert.equal(state.localTermination, "confirmed");
  assert.equal(state.remoteTermination, "unknown");
  assert.equal(state.lastToolLabel, "Edit File — src/example.js");
  assert.deepEqual(state.filesReportedByEditTools, ["src/example.js"]);
  assert.ok(state.heartbeatAt);
  const result = JSON.parse(
    await readFile(join(jobDirectory(root, created.jobId), "result.json"), "utf8")
  );
  assert.equal(result.result, "finished");
  assert.equal(result.jobId, created.jobId);
  assert.equal(result.lifecycle.status, "succeeded");
  const events = (await readFile(join(jobDirectory(root, created.jobId), "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "job-succeeded"));
});

test("session lock rejection happens before the fake prompt", async (t) => {
  const root = await makeRoot(t);
  const first = await createJob({ root, request: request("session-shared") });
  const second = await createJob({ root, request: request("session-shared") });
  await claimSessionLock({ root, sessionId: "session-shared", jobId: first.jobId });
  let promptCalled = false;

  const outcome = await runDelegationJob({
    root,
    jobId: second.jobId,
    runDelegate: async (options) => {
      const client = { stop: async () => true };
      options.onClientReady?.(client);
      options.onSessionReady?.("session-shared", client);
      await options.beforePrompt({ sessionId: "session-shared", client });
      promptCalled = true;
      return { result: "must not run", sessionId: "session-shared" };
    },
  });

  assert.equal(promptCalled, false);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "session-busy");
  assert.equal(outcome.holderJobId, first.jobId);
  assert.equal((await readJobState(root, second.jobId)).status, "failed");
});

test("a failure before client startup records not-started termination", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: request() });
  const outcome = await runDelegationJob({
    root,
    jobId: created.jobId,
    runDelegate: async () => {
      const error = new Error("workspace rejected");
      error.reason = "invalid-workspace";
      throw error;
    },
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "invalid-workspace");
  assert.equal(outcome.localTermination, "not-started");
  assert.equal(outcome.remoteTermination, "not-applicable");
});

test("cleanup failure cannot produce a successful terminal state", async (t) => {
  const root = await makeRoot(t);
  const created = await createJob({ root, request: request() });
  const outcome = await runDelegationJob({
    root,
    jobId: created.jobId,
    runDelegate: async (options) => {
      const client = { stop: async () => false };
      options.onClientReady?.(client);
      options.onSessionReady?.("session-cleanup", client);
      await options.beforePrompt({ sessionId: "session-cleanup", client });
      return { result: "work completed", sessionId: "session-cleanup" };
    },
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "cleanup-failed");
  assert.equal(outcome.localTermination, "failed");
  assert.equal(outcome.delegateResult.result, "work completed");
});

test("runner entrypoint never writes protocol data to stdout on startup errors", () => {
  const runner = fileURLToPath(new URL("../src/job-runner.js", import.meta.url));
  const child = spawnSync(process.execPath, [runner], { encoding: "utf8" });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /usage:/i);
});
