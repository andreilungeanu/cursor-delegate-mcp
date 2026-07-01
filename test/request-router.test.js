import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestRouter } from "../src/request-router.js";

function harness({ onElicit, onCreatePlan, mode } = {}) {
  const responses = []; const logs = [];
  const router = createRequestRouter({
    respond: (id, result) => responses.push({ id, result }),
    respondError: (id, code, message) => responses.push({ id, error: { code, message } }),
    onElicit,
    onCreatePlan,
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

test("ask_question forwards to elicitation and returns the chosen option", async () => {
  let elicited;
  const { router, responses } = harness({
    onElicit: async (q) => {
      elicited = q;
      return { answers: [{ questionId: "q1", selectedOptionIds: ["b"] }] };
    },
  });
  await router(6, "cursor/ask_question", {
    title: "Pick one",
    questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
  });
  assert.equal(responses[0].id, 6);
  assert.deepEqual(responses[0].result, {
    outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["b"] }] },
  });
  assert.equal(elicited.kind, "ask_question");
  assert.equal(elicited.title, "Pick one");
  assert.equal(elicited.questions.length, 1);
  assert.equal(elicited.questions[0].prompt, "Which?");
});

test("update_todos is acked with empty result", async () => {
  const { router, responses, logs } = harness();
  await router(7, "cursor/update_todos", { todos: [] });
  assert.deepEqual(responses[0], { id: 7, result: {} });
  assert.equal(logs.length, 1);
});

test("unknown method fails safe with an error, never hangs", async () => {
  const { router, responses } = harness();
  await router(8, "cursor/some_future_method", { weird: true });
  assert.equal(responses[0].id, 8);
  assert.ok(responses[0].error, "response must contain error");
  assert.equal(responses[0].error.code, -32601, "error code must be -32601 for unknown method");
});

test("ask_question fail-safe when onElicit returns null", async () => {
  const { router, responses } = harness();
  await router(9, "cursor/ask_question", { questions: [{ id: "q1", prompt: "Q", options: [{ id: "a", label: "A" }] }] });
  assert.deepEqual(responses[0], { id: 9, result: { outcome: { outcome: "cancelled" } } });
});

test("ask_question fail-safe when onElicit returns object without answers", async () => {
  const { router, responses } = harness({ onElicit: async () => ({}) });
  await router(10, "cursor/ask_question", { questions: [{ id: "q1", prompt: "Q", options: [{ id: "a", label: "A" }] }] });
  assert.deepEqual(responses[0], { id: 10, result: { outcome: { outcome: "cancelled" } } });
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

test("catch path: thrown onElicit error returns error response", async () => {
  const { router, responses } = harness({
    onElicit: async () => { throw new Error("boom"); },
  });
  await router(13, "cursor/ask_question", { questions: [{ id: "q1", prompt: "Q", options: [{ id: "a", label: "A" }] }] });
  assert.ok(responses[0].error, "response must contain error");
  assert.equal(responses[0].error.code, -32000, "error code must be -32000 for internal error");
});
