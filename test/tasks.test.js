import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskStore, runAsTask } from "../src/tasks.js";

const HOUR = 60 * 60 * 1000;

function clockedStore(opts) {
  let t = Date.parse("2026-11-23T00:00:00Z");
  const store = createTaskStore({ now: () => t, ...opts });
  return { store, advance: (ms) => { t += ms; } };
}

test("a finished task is kept for an hour after it ends and a working one is never dropped", () => {
  const { store, advance } = clockedStore();
  const working = store.create();
  const done = store.create();
  store.add(working);
  store.add(done);
  advance(5 * HOUR);
  store.finish(done, { result: { content: [] } });
  advance(HOUR);
  assert.equal(store.get(done.taskId)?.status, "completed");
  advance(1);
  assert.equal(store.get(done.taskId), undefined);
  advance(100 * HOUR);
  assert.equal(store.get(working.taskId)?.status, "working");
});

test("past the cap, the earliest finished tasks are dropped first", () => {
  const { store, advance } = clockedStore({ maxFinished: 2 });
  const tasks = [0, 1, 2].map(() => { const task = store.create(); store.add(task); return task; });
  const running = store.create();
  store.add(running);
  for (const task of [tasks[1], tasks[0], tasks[2]]) { advance(1); store.finish(task, { result: {} }); }
  assert.equal(store.get(tasks[1].taskId), undefined);
  assert.ok(store.get(tasks[0].taskId));
  assert.ok(store.get(tasks[2].taskId));
  assert.ok(store.get(running.taskId));
});

test("a task's ttlMs is null while it works and counts from its creation once it ends", () => {
  const { store, advance } = clockedStore();
  const task = store.create();
  store.add(task);
  assert.equal(store.view(task).ttlMs, null);
  advance(90_000);
  store.finish(task, { result: {} });
  assert.equal(store.view(task).ttlMs, 90_000 + HOUR);
});

test("pollIntervalMs is 3 s for a task's first minute and 10 s after", () => {
  const { store, advance } = clockedStore();
  const task = store.create();
  store.add(task);
  assert.equal(store.view(task).pollIntervalMs, 3000);
  advance(59_999);
  assert.equal(store.view(task).pollIntervalMs, 3000);
  advance(1);
  assert.equal(store.view(task).pollIntervalMs, 10000);
});

test("a failed task carries an internal error and a cancelled one keeps its status when the run ends", () => {
  const { store } = clockedStore();
  const failed = store.create();
  store.add(failed);
  store.finish(failed, { error: new Error("boom") });
  assert.deepEqual(store.view(failed).error, { code: -32603, message: "boom" });
  const cancelled = store.create();
  cancelled.sessionId = "sess-x";
  store.add(cancelled);
  store.cancel(cancelled);
  assert.equal(cancelled.ac.signal.aborted, true);
  store.finish(cancelled, { result: { content: [] } });
  const view = store.view(cancelled);
  assert.equal(view.status, "cancelled");
  assert.equal(view.result, undefined);
  assert.equal(view.statusMessage, "cancelled; resume with resumeSessionId sess-x");
});

test("a run that fails before its prompt is sent rejects runAsTask instead of creating a task", async () => {
  const store = createTaskStore();
  await assert.rejects(runAsTask({ run: async () => { throw new Error("setup failed"); }, store }), /setup failed/);
});

test("a run that throws after its prompt is sent leaves the task failed with an internal error", async () => {
  const store = createTaskStore();
  let fail;
  const answer = await runAsTask({
    run: ({ onPromptSent }) => { onPromptSent("sess-x"); return new Promise((_, reject) => { fail = reject; }); },
    store,
  });
  assert.equal(answer.resultType, "task");
  fail(new Error("boom"));
  await new Promise((r) => setImmediate(r));
  const view = store.view(store.get(answer.taskId));
  assert.equal(view.status, "failed");
  assert.deepEqual(view.error, { code: -32603, message: "boom" });
});

test("the request's cancellation no longer reaches a run once its task is answered", async () => {
  const store = createTaskStore();
  const request = new AbortController();
  let runSignal;
  const answer = await runAsTask({
    run: ({ signal, onPromptSent }) => { runSignal = signal; onPromptSent("sess-x"); return new Promise(() => {}); },
    signal: request.signal,
    store,
  });
  request.abort();
  assert.equal(runSignal.aborted, false);
  assert.equal(store.get(answer.taskId)?.status, "working");
});

test("a request cancelled as its prompt goes out gets the run's own result, not a task", async () => {
  const store = createTaskStore();
  const request = new AbortController();
  const answer = await runAsTask({
    run: async ({ signal, onPromptSent }) => {
      request.abort();
      onPromptSent("sess-x");
      await new Promise((r) => setTimeout(r, 20));
      return { content: [{ type: "text", text: `aborted: ${signal.aborted}` }] };
    },
    signal: request.signal,
    store,
  });
  assert.equal(answer.resultType, undefined);
  assert.equal(answer.content[0].text, "aborted: true");
});
