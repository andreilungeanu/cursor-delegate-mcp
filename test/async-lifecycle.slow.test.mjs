import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJobState } from "../src/job-store.js";
import { connectLifecycleServer, payload, waitForTerminal } from "./fixtures/async-lifecycle-client.mjs";

test("controlled job runs beyond 320 seconds across an MCP restart", {
  timeout: 345_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-delegate-slow-"));
  const jobsRoot = join(root, "jobs");
  const logPath = join(root, "acp-events.ndjson");
  t.after(() => rm(root, { recursive: true, force: true }));
  let activeClient;

  try {
    const first = await connectLifecycleServer(root, logPath, {
      durationMs: 321_000,
      sessionId: "async-long-321s",
    });
    const startedAt = Date.now();
    const started = payload(await first.client.callTool({
      name: "start",
      arguments: {
        spec: "run the harmless 321 second lifecycle fixture",
        workspace: root,
        clientRequestId: "long-lifecycle-once",
      },
    }));
    assert.ok(Date.now() - startedAt < 5_000);
    const jobId = started.jobId;
    const initial = await readJobState(jobsRoot, jobId);
    await first.client.close();

    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await connectLifecycleServer(root, logPath, {
      durationMs: 321_000,
      sessionId: "async-long-321s",
    });
    activeClient = second.client;
    const terminal = await waitForTerminal(second.client, jobId, {
      deadlineMs: 340_000,
      timeoutMs: 30_000,
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed > 320_000, `job completed after ${elapsed}ms`);
    assert.equal(terminal.job.status, "succeeded", JSON.stringify(terminal.job));

    const result = payload(await second.client.callTool({
      name: "result",
      arguments: { jobId },
    }));
    assert.equal(result.result, "long task completed");
    assert.equal(result.lifecycle.localTermination, "confirmed");
    assert.equal(result.lifecycle.remoteTermination, "unknown");
    const final = await readJobState(jobsRoot, jobId);
    assert.equal(final.spawnToken, initial.spawnToken);
    assert.equal(final.runnerPid > 0, true);

    const events = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === "prompt").length, 1);
    assert.equal(events.filter((event) => event.event === "cancel").length, 0);
    assert.ok(terminal.revisions.length > 0);
  } finally {
    await activeClient?.close().catch(() => {});
  }
});
