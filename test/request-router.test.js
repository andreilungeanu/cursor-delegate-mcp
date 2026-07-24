import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestRouter } from "../src/request-router.js";

function harness({ onCreatePlan, onTodos, mode } = {}) {
  const responses = []; const logs = [];
  const router = createRequestRouter({
    respond: (id, result) => responses.push({ id, result }),
    respondError: (id, code, message) => responses.push({ id, error: { code, message } }),
    onCreatePlan,
    onTodos,
    mode,
    log: (e) => logs.push(e),
  });
  return { router, responses, logs };
}

test("request_permission auto-selects allow_always", async () => {
  const { router, responses } = harness();
  await router(5, "session/request_permission", {
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  });
  assert.deepEqual(responses[0], { id: 5, result: { outcome: { outcome: "selected", optionId: "allow-always" } } });
});

test("ask_question is an unhandled method (elicitation removed) and fails safe with -32601", async () => {
  // cursor-agent never exposes AskQuestion over ACP; the bridge no longer implements a
  // structured answer path, so a frame (if one ever arrived) falls through to the default.
  const { router, responses } = harness();
  await router(6, "cursor/ask_question", {
    title: "Pick one",
    questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "A" }] }],
  });
  assert.equal(responses[0].id, 6);
  assert.ok(responses[0].error, "response must contain error");
  assert.equal(responses[0].error.code, -32601);
});

test("update_todos is acked with empty result", async () => {
  const { router, responses, logs } = harness();
  await router(7, "cursor/update_todos", { todos: [] });
  assert.deepEqual(responses[0], { id: 7, result: {} });
  assert.equal(logs.length, 1);
});

test("update_todos forwards todos, merge and toolCallId to onTodos", async () => {
  const seen = [];
  const { router, responses } = harness({ onTodos: (t) => seen.push(t) });
  await router(0, "cursor/update_todos", {
    todos: [{ id: "1", content: "Create b1.txt", status: "in_progress" }],
    merge: true,
    toolCallId: "tool_a4435fca",
  });
  assert.deepEqual(responses[0], { id: 0, result: {} });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].merge, true);
  assert.equal(seen[0].toolCallId, "tool_a4435fca");
  assert.deepEqual(seen[0].todos, [{ id: "1", content: "Create b1.txt", status: "in_progress" }]);
});

test("update_todos still acks when no onTodos is wired", async () => {
  const { router, responses } = harness();
  await router(3, "cursor/update_todos", { todos: [], merge: false });
  assert.deepEqual(responses[0], { id: 3, result: {} });
});

test("unknown method fails safe with an error, never hangs", async () => {
  const { router, responses } = harness();
  await router(8, "cursor/some_future_method", { weird: true });
  assert.equal(responses[0].id, 8);
  assert.ok(responses[0].error, "response must contain error");
  assert.equal(responses[0].error.code, -32601, "error code must be -32601 for unknown method");
});

test("create_plan rejects in plan mode and captures body", async () => {
  let captured;
  const { router, responses } = harness({
    mode: "plan",
    onCreatePlan: (body) => { captured = body; },
  });
  await router(11, "cursor/create_plan", { overview: "summary", plan: "# Steps", name: "My plan" });
  assert.deepEqual(responses[0], { id: 11, result: { outcome: { outcome: "rejected" } } });
  assert.equal(captured.overview, "summary");
  assert.equal(captured.plan, "# Steps");
  assert.equal(captured.name, "My plan");
});

test("create_plan rejects in ask mode", async () => {
  const { router, responses } = harness({ mode: "ask" });
  await router(12, "cursor/create_plan", { overview: "plan" });
  assert.deepEqual(responses[0], { id: 12, result: { outcome: { outcome: "rejected" } } });
});

test("create_plan accepts in agent mode", async () => {
  const { router, responses } = harness({ mode: "agent" });
  await router(13, "cursor/create_plan", { overview: "plan" });
  assert.deepEqual(responses[0], { id: 13, result: { outcome: { outcome: "accepted" } } });
});

test("catch path: a thrown handler error returns a -32000 error response", async () => {
  const { router, responses } = harness({
    onCreatePlan: () => { throw new Error("boom"); },
  });
  await router(13, "cursor/create_plan", { overview: "plan" });
  assert.ok(responses[0].error, "response must contain error");
  assert.equal(responses[0].error.code, -32000, "error code must be -32000 for internal error");
});
