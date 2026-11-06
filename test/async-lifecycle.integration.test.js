import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJobState } from "../src/job-store.js";
import { connectLifecycleServer, payload, waitForTerminal } from "./fixtures/async-lifecycle-client.mjs";

test("MCP restart keeps the runner alive and returns one durable result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-cross-process-"));
  const jobsRoot = join(root, "jobs");
  const logPath = join(root, "acp-events.ndjson");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await connectLifecycleServer(root, logPath);
  const startedAt = Date.now();
  const started = payload(await first.client.callTool({
    name: "start",
    arguments: {
      spec: "run the harmless lifecycle fixture",
      workspace: root,
      clientRequestId: "cross-process-once",
    },
  }));
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(started.status, "queued");
  assert.equal(started.sessionId, null);
  const jobId = started.jobId;
  const stateBeforeRestart = await readJobState(jobsRoot, jobId);
  await first.client.close();

  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = await connectLifecycleServer(root, logPath);
  try {
    const retried = payload(await second.client.callTool({
      name: "start",
      arguments: {
        spec: "run the harmless lifecycle fixture",
        workspace: root,
        clientRequestId: "cross-process-once",
      },
    }));
    assert.equal(retried.jobId, jobId);
    const afterRestart = await readJobState(jobsRoot, jobId);
    assert.equal(afterRestart.spawnToken, stateBeforeRestart.spawnToken);

    const terminal = await waitForTerminal(second.client, jobId);
    assert.equal(terminal.job.status, "succeeded", JSON.stringify(terminal.job));
    assert.ok(terminal.revisions.length > 0);
    const result = payload(await second.client.callTool({
      name: "result",
      arguments: { jobId },
    }));
    assert.equal(result.status, "succeeded");
    assert.equal(result.result, "long task completed");
    assert.equal(result.lifecycle.localTermination, "confirmed");
    assert.equal(result.lifecycle.remoteTermination, "unknown");

    const events = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === "prompt").length, 1);
    assert.equal(events.filter((event) => event.event === "cancel").length, 0);
    const finalState = await readJobState(jobsRoot, jobId);
    assert.equal(finalState.runnerPid > 0, true);
    assert.equal(finalState.status, "succeeded");
  } finally {
    await second.client.close();
  }
});
