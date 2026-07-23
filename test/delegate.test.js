import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { AcpClient } from "../src/acp-client.js";
import { runDelegate } from "../src/delegate.js";

function thinkingFactory() {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-think" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET-THOUGHT: planning" } } });
      client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit File", kind: "edit", status: "pending" } });
      client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

function fakeFactory({ onElicit, mode, onCreatePlan }) {
  return new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/fake-acp.js", import.meta.url))],
      options: { shell: false },
    },
    onElicit,
    mode,
    onCreatePlan,
  });
}

function oversizedFactory() {
  const client = new EventEmitter();
  client.start = async () => {};
  client.initialize = async () => {};
  client.newSession = async () => ({ sessionId: "sess-big" });
  client.setModel = async () => {};
  client.setConfigOption = async () => {};
  client.setMode = async () => {};
  client.prompt = async () => {
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 12; i++) {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: chunk } } });
    }
    return { stopReason: "end_turn" };
  };
  client.stop = () => {};
  return client;
}

// One "x" then a single emoji chunk longer than the remaining budget, so the 10MB cut lands
// on the high surrogate of a pair (an even index) and must step back to stay well-formed.
function surrogateBoundaryFactory() {
  const client = new EventEmitter();
  client.start = async () => {};
  client.initialize = async () => {};
  client.newSession = async () => ({ sessionId: "sess-surrogate" });
  client.setModel = async () => {};
  client.setConfigOption = async () => {};
  client.setMode = async () => {};
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "x" } } });
    const emoji = "\u{1f525}".repeat(5 * 1024 * 1024);
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: emoji } } });
    return { stopReason: "end_turn" };
  };
  client.stop = () => {};
  return client;
}

function fastToggleFactory({ onSetFast }) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-track" });
    client.setModel = async () => {};
    client.setConfigOption = async (_sid, configId, value) => onSetFast?.(value, configId);
    client.setMode = async () => {};
    client.prompt = async () => ({ stopReason: "end_turn" });
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

// setConfigOption echoes the served model in configOptions (the measured post-set_model shape);
// rejectFast throws the -32602 a model without the fast knob returns.
function servedModelFactory({ served, rejectFast = false }) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-model" });
    client.setModel = async () => {};
    client.setConfigOption = async (_sid, configId) => {
      if (rejectFast && configId === "fast") {
        const err = new Error("Unknown model config option: fast");
        err.code = -32602;
        throw err;
      }
      return { configOptions: [{ id: "model", currentValue: served, options: [{ value: served }] }] };
    };
    client.setMode = async () => {};
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

test("runDelegate reports effectiveModel when the agent serves a different model than requested", async () => {
  const out = await runDelegate({
    spec: "task", model: "default", workspace: process.cwd(),
    clientFactory: servedModelFactory({ served: "composer-2.5" }),
  });
  assert.equal(out.effectiveModel, "composer-2.5");
});

test("runDelegate omits effectiveModel when the agent confirms the requested model", async () => {
  const out = await runDelegate({
    spec: "task", model: "composer-2.5", workspace: process.cwd(),
    clientFactory: servedModelFactory({ served: "composer-2.5" }),
  });
  assert.equal(out.effectiveModel, undefined);
});

test("runDelegate omits effectiveModel when the model reports no config (fast rejected)", async () => {
  const out = await runDelegate({
    spec: "task", model: "claude-haiku-4-5", fast: true, workspace: process.cwd(),
    clientFactory: servedModelFactory({ served: "ignored", rejectFast: true }),
  });
  assert.equal(out.effectiveModel, undefined);
  assert.ok(out.protocolWarnings.some((w) => /has no fast option/.test(w)));
});

test("runDelegate returns assembled result for a fresh session", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.stopReason, undefined);
  assert.equal(out.sessionId, "sess-1");
  assert.equal(out.result, "done");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.finalMessageAvailable, undefined);
  assert.equal(out.questionsAsked, undefined);
  assert.equal(out.resumed, undefined);
  assert.equal(out.plan, undefined);
});

test("runDelegate offers the fast toggle to every model", async () => {
  let fastCalls = 0;
  await runDelegate({
    spec: "task",
    model: "gpt-5.4",
    fast: true,
    workspace: process.cwd(),
    clientFactory: fastToggleFactory({ onSetFast: () => { fastCalls++; } }),
  });
  assert.equal(fastCalls, 1);

  fastCalls = 0;
  let fastValue;
  await runDelegate({
    spec: "task",
    model: "composer-2.5",
    fast: true,
    workspace: process.cwd(),
    clientFactory: fastToggleFactory({ onSetFast: (v) => { fastCalls++; fastValue = v; } }),
  });
  assert.equal(fastCalls, 1);
  assert.equal(fastValue, true);
});

test("runDelegate defaults fast to false for Composer when omitted", async () => {
  let fastValue;
  await runDelegate({
    spec: "task",
    model: "composer-2.5",
    workspace: process.cwd(),
    clientFactory: fastToggleFactory({ onSetFast: (v) => { fastValue = v; } }),
  });
  assert.equal(fastValue, false);
});

function rpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// These factories model a turn that emits no session/update at all, which now warns on its
// own ("no message closed the turn"). Config-option tests care only about their own warning.
const configWarnings = (out) => (out.protocolWarnings || []).filter((w) => / has no .* option/.test(w));

// Measured against claude-haiku-4-5, which has no fast variant.
const FAST_REFUSED = () => { throw rpcError(-32602, "Invalid params: Unknown model config option: fast"); };

test("runDelegate warns but completes when the model refuses the fast toggle", async () => {
  const out = await runDelegate({
    spec: "task", model: "claude-haiku-4-5", fast: true, workspace: process.cwd(),
    clientFactory: fastToggleFactory({ onSetFast: FAST_REFUSED }),
  });
  assert.equal(out.stopReason, undefined);
  assert.ok(out.protocolWarnings.some((w) => /claude-haiku-4-5 has no fast option/.test(w)));
});

test("runDelegate stays silent when a refused fast toggle was not asked for", async () => {
  const out = await runDelegate({
    spec: "task", model: "claude-haiku-4-5", fast: false, workspace: process.cwd(),
    clientFactory: fastToggleFactory({ onSetFast: FAST_REFUSED }),
  });
  assert.deepEqual(configWarnings(out), []);
});

test("runDelegate propagates a set_config_option failure that is not an unknown option", async () => {
  await assert.rejects(
    runDelegate({
      spec: "task", model: "composer-2.5", fast: true, workspace: process.cwd(),
      clientFactory: fastToggleFactory({ onSetFast: () => { throw rpcError(-32603, "Internal error"); } }),
    }),
    /Internal error/
  );
});

// Measured on gpt-5.4: reasoning accepts none|low|medium|high|extra-high, context 272k|1m.
function configFactory({ onSet, refuse = [], invalid = [] }) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-cfg" });
    client.setModel = async () => {};
    client.setConfigOption = async (_sid, configId, value) => {
      if (refuse.includes(configId)) throw rpcError(-32602, `Invalid params: Unknown model config option: ${configId}`);
      if (invalid.includes(configId)) throw rpcError(-32602, `Invalid params: Invalid value for ${configId}: ${value}`);
      onSet?.(configId, value);
    };
    client.setMode = async () => {};
    client.prompt = async () => ({ stopReason: "end_turn" });
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

test("runDelegate sends reasoning and context when the caller names them", async () => {
  const seen = [];
  const out = await runDelegate({
    spec: "task", model: "gpt-5.4", reasoning: "high", context: "1m",
    workspace: process.cwd(), clientFactory: configFactory({ onSet: (id, v) => seen.push([id, v]) }),
  });
  assert.deepEqual(seen, [["fast", false], ["reasoning", "high"], ["context", "1m"]]);
  assert.deepEqual(configWarnings(out), []);
});

test("runDelegate sends no reasoning or context when the caller omits them", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "composer-2.5",
    workspace: process.cwd(), clientFactory: configFactory({ onSet: (id) => seen.push(id) }),
  });
  assert.deepEqual(seen, ["fast"]);
});

test("runDelegate warns when the model has no reasoning option", async () => {
  const out = await runDelegate({
    spec: "task", model: "composer-2.5", reasoning: "high",
    workspace: process.cwd(), clientFactory: configFactory({ refuse: ["reasoning"] }),
  });
  assert.equal(out.stopReason, undefined);
  assert.deepEqual(configWarnings(out), [
    "model composer-2.5 has no reasoning option; the requested value was ignored",
  ]);
});

test("runDelegate fails loudly when a config value is rejected as invalid", async () => {
  await assert.rejects(
    runDelegate({
      spec: "task", model: "gpt-5.4", reasoning: "banana",
      workspace: process.cwd(), clientFactory: configFactory({ invalid: ["reasoning"] }),
    }),
    (err) => {
      assert.match(err.message, /Invalid value for reasoning: banana/);
      assert.equal(err.reason, "agent-error");
      return true;
    }
  );
});

test("runDelegate leaves an existing reason alone and tags nothing without an rpc code", async () => {
  const factory = () => {
    const client = new EventEmitter();
    client.start = async () => { throw new Error("spawn failed"); };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
  await assert.rejects(
    runDelegate({ spec: "task", workspace: process.cwd(), clientFactory: factory }),
    (err) => {
      assert.equal(err.reason, undefined);
      return true;
    }
  );
  await assert.rejects(
    runDelegate({
      spec: "task", model: "no-such-model", workspace: process.cwd(),
      clientFactory: modelListFactory([{ modelId: "composer-2.5" }]),
    }),
    (err) => {
      assert.equal(err.reason, "unknown-model");
      return true;
    }
  );
});

test("runDelegate surfaces the agent-assigned title as progress, not in the result", async () => {
  const progress = [];
  const factory = () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-titled" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "session_info_update", title: "File Creator" } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
  const out = await runDelegate({ spec: "task", workspace: process.cwd(), clientFactory: factory, onProgress: (m) => progress.push(m) });
  // The title is a live label (and timeout forensics); in the result it arrives too late to
  // help and has been measured contradicting the answer.
  assert.equal(out.sessionTitle, undefined);
  assert.ok(progress.includes("turn titled: File Creator"), `expected title progress line, got ${JSON.stringify(progress)}`);
  assert.equal(out.result, "done");
});

test("runDelegate reports why a failed resume started a fresh session", async () => {
  const factory = () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.loadSession = async () => { throw rpcError(-32602, "Invalid params: Session old-id not found"); };
    client.newSession = async () => ({ sessionId: "sess-fresh" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => ({ stopReason: "end_turn" });
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
  const out = await runDelegate({
    spec: "task", resumeSessionId: "old-id", workspace: process.cwd(), clientFactory: factory,
  });
  assert.equal(out.sessionId, "sess-fresh");
  assert.equal(out.resumed, undefined);
  assert.ok(out.protocolWarnings.some((w) => /resuming old-id failed.*Session old-id not found/.test(w)));
});

test("runDelegate captures session/update:plan with latest update winning", async () => {
  const out = await runDelegate({ spec: "draft a plan", mode: "plan", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.stopReason, undefined);
  // "plan ready" is too terse to be the plan, so the filed plan is folded into result — with
  // the agent's own reply preserved under a separator rather than silently dropped.
  assert.equal(out.result, "# Plan\n\n1. Create CHANGELOG.md\n\n--- agent chat reply:\nplan ready");
  assert.equal(out.resultSource, "plan-detail");
  assert.ok(out.plan);
  assert.deepEqual(out.plan.entries, [
    { content: "Create CHANGELOG.md", priority: "medium", status: "pending" },
  ]);
  assert.equal(out.plan.overview, "Add a changelog file");
  assert.equal(out.plan.detail, undefined, "the plan is now in result, not duplicated in detail");
  assert.equal(out.filesReportedByEditTools, undefined);
});

function planDetailFactory({ message, overview, plan, trailingTool = false }) {
  return ({ onCreatePlan }) => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-plandetail" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      onCreatePlan?.({ overview, plan });
      client.emit("update", { update: { sessionUpdate: "plan", entries: [{ content: "step", priority: "low", status: "pending" }] } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: message } } });
      // A trailing tool call discards the message, so no final message closes the turn.
      if (trailingTool) {
        client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "tool", status: "pending" } });
        client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
      }
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

// The one-plan contract: in plan/ask the plan is never load-bearing (it lives in the agent's own
// session, which is what a resume-to-implement reads), so it is kept in exactly one prose channel
// — result — and dropped from plan.detail. entries and overview always survive.
test("runDelegate drops plan.detail when result is a real plan message, even if detail is longer", async () => {
  const message = "Here is the plan in full. " + "Ship the change step by step with rationale. ".repeat(5);
  const plan = message + " " + "Extra rendered detail with mermaid the orchestrator never needs. ".repeat(5);
  assert.ok(message.length >= 200 && plan.length > message.length, "a real message longer than the floor, shorter than detail");
  const out = await runDelegate({
    spec: "plan it", mode: "plan", workspace: process.cwd(),
    clientFactory: planDetailFactory({ message, overview: "ov", plan }),
  });
  assert.equal(out.result, message, "the real message stays as result");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.plan.detail, undefined, "detail is a duplicate of the filed plan and is dropped");
  assert.equal(out.plan.overview, "ov");
  assert.deepEqual(out.plan.entries, [{ content: "step", priority: "low", status: "pending" }]);
});

test("runDelegate folds plan.detail into result when the message is too terse", async () => {
  const plan = "# Plan\n\n1. Do the thing with a lot of detailed explanation and several steps.";
  const out = await runDelegate({
    spec: "plan it", mode: "plan", workspace: process.cwd(),
    clientFactory: planDetailFactory({ message: "plan ready", overview: "ov", plan }),
  });
  assert.equal(out.result, plan + "\n\n--- agent chat reply:\nplan ready", "the terse message is replaced by the filed plan, its text kept under a separator");
  assert.equal(out.resultSource, "plan-detail");
  assert.equal(out.plan.detail, undefined, "the plan is in result now, not duplicated in detail");
});

test("runDelegate preserves a real question the agent asked when promoting the filed plan", async () => {
  const plan = "# Plan\n\n1. Add the config loader with a detailed multi-step rollout description.";
  const question = "Should the config format be TOML or JSON?";
  const out = await runDelegate({
    spec: "file the plan and ask the format", mode: "plan", workspace: process.cwd(),
    clientFactory: planDetailFactory({ message: question, overview: "ov", plan }),
  });
  assert.equal(out.resultSource, "plan-detail");
  assert.ok(out.result.endsWith("\n\n--- agent chat reply:\n" + question), "the agent's question survives promotion");
});

test("runDelegate does not re-append a chat message identical to the filed plan", async () => {
  const plan = "# Plan\n\n1. A short plan the agent also sent verbatim as its chat message.";
  const out = await runDelegate({
    spec: "plan it", mode: "plan", workspace: process.cwd(),
    clientFactory: planDetailFactory({ message: plan, overview: "ov", plan }),
  });
  assert.equal(out.result, plan, "no self-duplication when message equals the plan");
  assert.ok(!out.result.includes("--- agent chat reply:"));
});

test("runDelegate folds plan.detail into result when a trailing tool leaves no final message", async () => {
  const plan = "# Plan\n\n1. A detailed multi-step plan filed before the agent ran a tool.";
  const out = await runDelegate({
    spec: "plan it", mode: "plan", workspace: process.cwd(),
    clientFactory: planDetailFactory({ message: "Reviewing the code.", overview: "ov", plan, trailingTool: true }),
  });
  assert.equal(out.result, plan, "the filed plan wins over the discarded preamble");
  assert.equal(out.resultSource, "plan-detail");
  assert.equal(out.finalMessageAvailable, undefined);
  assert.equal(out.plan.detail, undefined);
  assert.ok(!out.result.includes("--- agent chat reply:"), "a discarded preamble is not the agent's closing reply, so it is not appended");
  assert.ok(!out.protocolWarnings?.some((w) => /never spoke again/.test(w)), "result carries the plan, so no stale fallback warning");
});

test("runDelegate keeps plan.detail in agent mode alongside the implementation report", async () => {
  const plan = "# Plan\n\n1. The plan document the agent filed via create_plan.";
  const message = "Implemented the change: edited three files and the tests pass.";
  const out = await runDelegate({
    spec: "do it", mode: "agent", workspace: process.cwd(),
    clientFactory: planDetailFactory({ message, overview: "ov", plan }),
  });
  assert.equal(out.result, message, "result is the implementation report");
  assert.equal(out.plan.detail, plan, "the plan doc and the report are different artifacts; both stay");
  assert.equal(out.plan.overview, "ov");
});

test("runDelegate plan-mode filesReportedByEditTools is omitted (no diff events)", async () => {
  const out = await runDelegate({ spec: "draft a plan", mode: "plan", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.filesReportedByEditTools, undefined, "absence, not an empty list, means nothing was reported");
});

test("runDelegate omits plan when no plan was emitted", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.plan, undefined);
});

test("runDelegate populates filesReportedByEditTools from a tool_call_update diff (real-agent shape)", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.deepEqual(out.filesReportedByEditTools, ["hello.txt"]);
});

test("runDelegate reports diff-event paths in a non-git workspace", async () => {
  // Attribution comes only from native ACP diff events, so git state is irrelevant.
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: tmpdir(), clientFactory: fakeFactory });
  assert.deepEqual(out.filesReportedByEditTools, ["hello.txt"]);
});

test("runDelegate does not fold reasoning (thinking) into the result", async () => {
  const progress = [];
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: thinkingFactory(),
    onProgress: (m) => progress.push(m),
  });
  assert.equal(out.result, "done");
  assert.ok(!out.result.includes("SECRET-THOUGHT"), "reasoning must not appear in the result");
  assert.ok(progress.some((m) => m.startsWith("thinking:")), "expected thinking progress");
  assert.ok(progress.some((m) => m.startsWith("running:")), "expected tool_call start progress");
});

test("runDelegate calls onProgress on agent message chunks and tool-call updates", async () => {
  const progress = [];
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: fakeFactory,
    onProgress: (msg) => progress.push(msg),
  });
  assert.equal(out.result, "done");
  assert.ok(progress.some((m) => m.includes("done")), "expected message-chunk progress");
  assert.ok(progress.some((m) => m.includes("editing hello.txt")), "expected tool-call progress");
});

const replayFactory = (updates) => () => {
  const client = new EventEmitter();
  client.start = async () => {};
  client.initialize = async () => {};
  client.newSession = async () => ({ sessionId: "sess-replay" });
  client.setModel = async () => {};
  client.setConfigOption = async () => {};
  client.setMode = async () => {};
  client.prompt = async () => {
    for (const update of updates) client.emit("update", { update });
    return { stopReason: "end_turn" };
  };
  client.getTranscript = () => "";
  client.stop = () => {};
  return client;
};

const msgChunk = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thoughtChunk = (text) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const toolCall = (toolCallId, status = "pending") => ({ sessionUpdate: "tool_call", toolCallId, title: "tool", status });
const toolUpdate = (toolCallId, status) => ({ sessionUpdate: "tool_call_update", toolCallId, status });

async function replayResult(updates) {
  return runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: replayFactory(updates),
  });
}

async function collectProgress(updates, opts = {}) {
  const progress = [];
  await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: replayFactory(updates),
    onProgress: (m) => progress.push(m),
    ...opts,
  });
  return progress;
}

test("runDelegate joins streamed fragments into complete-sentence progress", async () => {
  const progress = await collectProgress([
    thoughtChunk("checking the call si"),
    thoughtChunk("tes in src/api. Then the tests"),
    msgChunk("Convert"),
    msgChunk("ing getUser to asy"),
    msgChunk("nc now. Updating expo"),
    msgChunk("rts next"),
  ]);
  assert.ok(progress.includes("thinking: checking the call sites in src/api."), "thought fragments joined at sentence boundary");
  assert.ok(progress.includes("Cursor: Converting getUser to async now."), "message fragments joined at sentence boundary");
  assert.ok(progress.includes("Cursor: Updating exports next"), "trailing buffer flushed at end of turn");
  assert.ok(!progress.some((m) => m.includes("asy") && !m.includes("async")), "no mid-word fragments emitted");
});

test("runDelegate splits cursor thought summaries that arrive with no separator", async () => {
  const progress = await collectProgress([
    thoughtChunk("This mismatch prevents the utility from receiving its expected input."),
    thoughtChunk("A concrete bug was identified in write-settings-conf."),
    thoughtChunk("The script only reads from standard input."),
  ]);
  assert.ok(progress.includes("thinking: This mismatch prevents the utility from receiving its expected input."), "first summary emits as its own line");
  assert.ok(!progress.some((m) => m.includes("input.A")), "no jammed sentence boundaries");
});

test("runDelegate throttles progress: newest sentence wins, middle ones drop", async () => {
  const progress = await collectProgress(
    [msgChunk("First point. Second point. Third point. ")],
    { progressThrottleMs: 60000 },
  );
  assert.ok(progress.includes("Cursor: First point."), "first sentence emits immediately");
  assert.ok(!progress.includes("Cursor: Second point."), "throttled middle sentence is dropped");
  assert.ok(progress.includes("Cursor: Third point."), "latest pending sentence flushes at end of turn");
});

test("runDelegate skips markdown structure in progress (tables, headings, fences, bullets)", async () => {
  const progress = await collectProgress([
    msgChunk("| Privileged ops | 23 bash sbin scripts |\n"),
    msgChunk("## Assessment\n"),
    msgChunk("```\ncode line\n```\n"),
    msgChunk("- bullet item\n"),
    msgChunk("The build script downloads binaries without checksums.\n"),
  ]);
  assert.ok(!progress.some((m) => m.includes("Privileged ops")), "table rows are not progress");
  assert.ok(!progress.some((m) => m.includes("Assessment")), "headings are not progress");
  assert.ok(!progress.some((m) => m.includes("bullet item")), "bullets are not progress");
  assert.ok(progress.includes("Cursor: The build script downloads binaries without checksums."), "prose still flows through");
});

test("runDelegate includes the tool location in running: progress when present", async () => {
  const progress = await collectProgress([
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read File", kind: "read", status: "pending", locations: [{ path: "src/api/user.js" }] },
    { sessionUpdate: "tool_call", toolCallId: "t2", title: "grep", kind: "search", status: "pending", rawInput: {} },
  ]);
  assert.ok(progress.includes("running: Read File — src/api/user.js"), "location path shown");
  assert.ok(progress.includes("running: grep"), "bare label when the agent sends no location");
});

test("runDelegate returns the complete stream when the turn uses no tools", async () => {
  const out = await replayResult([msgChunk("Code:\n"), msgChunk("```js\nrun();\n```")]);
  assert.equal(out.result, "Code:\n```js\nrun();\n```");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.finalMessageAvailable, undefined);
});

test("runDelegate returns only text emitted after the final tool completes", async () => {
  const out = await replayResult([
    msgChunk("', '', raw, flags=re.DOTALL).strip()\n"),
    toolCall("edit-1"),
    msgChunk("text emitted while the tool is active"),
    toolUpdate("edit-1", "completed"),
    msgChunk("Updated `sbin/setup-llm` and validated it."),
  ]);
  assert.equal(out.result, "Updated `sbin/setup-llm` and validated it.");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.finalMessageAvailable, undefined);
});

test("runDelegate discards text that is followed by another tool call", async () => {
  const out = await replayResult([
    msgChunk("Inspecting the implementation."),
    toolCall("read-1"),
    toolUpdate("read-1", "completed"),
    msgChunk("Found the likely issue; checking callers."),
    toolCall("search-1"),
    toolUpdate("search-1", "completed"),
    msgChunk("The callers are updated and tests pass."),
  ]);
  assert.equal(out.result, "The callers are updated and tests pass.");
  assert.equal(out.resultSource, undefined);
});

test("runDelegate waits for all active tools before collecting final text", async () => {
  const out = await replayResult([
    toolCall("read-1"),
    toolCall("read-2"),
    toolUpdate("read-1", "completed"),
    msgChunk("one tool is still active"),
    toolUpdate("read-2", "completed"),
    msgChunk("Both reads completed; here is the answer."),
  ]);
  assert.equal(out.result, "Both reads completed; here is the answer.");
  assert.equal(out.resultSource, undefined);
});

// This shape used to return "" with stopReason end_turn and no error. The discarded text is
// as often the whole answer as a preamble, so label it, warn, and return it.
test("runDelegate falls back to the last message when a tool call ends the turn", async () => {
  const out = await replayResult([
    msgChunk("I will make the edit."),
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
  ]);
  assert.equal(out.result, "I will make the edit.");
  assert.equal(out.resultSource, "pre-tool-fallback");
  assert.equal(out.finalMessageAvailable, undefined);
  assert.ok(out.protocolWarnings.some((w) => /never spoke again/.test(w)), "the fallback is disclosed");
});

test("runDelegate falls back to the answer, not the preamble, when both were discarded", async () => {
  const out = await replayResult([
    msgChunk("Inspecting the implementation."),
    toolCall("read-1"),
    toolUpdate("read-1", "completed"),
    msgChunk("The parser drops the trailing byte."),
    toolCall("verify-1"),
    toolUpdate("verify-1", "completed"),
  ]);
  assert.equal(out.result, "The parser drops the trailing byte.");
  assert.equal(out.resultSource, "pre-tool-fallback");
});

test("runDelegate warns rather than returning a bare empty success", async () => {
  const out = await replayResult([toolCall("edit-1"), toolUpdate("edit-1", "completed")]);
  assert.equal(out.result, "");
  assert.equal(out.resultSource, "none");
  assert.equal(out.finalMessageAvailable, undefined);
  assert.ok(out.protocolWarnings.some((w) => /without emitting any message/.test(w)));
});

test("runDelegate prefers a real final message over the fallback", async () => {
  const out = await replayResult([
    msgChunk("I will make the edit."),
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
    msgChunk("Edited the parser."),
  ]);
  assert.equal(out.result, "Edited the parser.");
  assert.equal(out.resultSource, undefined);
  assert.ok(!(out.protocolWarnings || []).some((w) => /never spoke again/.test(w)));
});

test("runDelegate keeps the final message when a duplicate terminal tool update arrives late", async () => {
  const out = await replayResult([
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
    msgChunk("Fixed the parser and added a regression test."),
    toolUpdate("edit-1", "completed"),
  ]);
  assert.equal(out.result, "Fixed the parser and added a regression test.");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.finalMessageAvailable, undefined);
});

test("runDelegate preserves a legitimate code-only final response", async () => {
  const code = "```js\nexport const answer = 42;\n```";
  const out = await replayResult([
    toolCall("read-1"),
    toolUpdate("read-1", "completed"),
    msgChunk(code),
  ]);
  assert.equal(out.result, code);
  assert.equal(out.resultSource, undefined);
});

test("runDelegate survives a throwing onProgress callback", async () => {
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: fakeFactory,
    onProgress: () => { throw new Error("progress boom"); },
  });
  assert.equal(out.result, "done");
});

function trackingFactory(track) {
  return ({ onElicit, mode, onCreatePlan }) => {
    const client = fakeFactory({ onElicit, mode, onCreatePlan });
    const origPrompt = client.prompt.bind(client);
    client.prompt = async (sessionId, text) => {
      track.promptSessionId = sessionId;
      return origPrompt(sessionId, text);
    };
    return client;
  };
}

test("runDelegate resumes a persisted session via session/load", async () => {
  const knownId = "sess-resumed";
  const track = {};
  const out = await runDelegate({
    spec: "continue the task",
    mode: "agent",
    resumeSessionId: knownId,
    workspace: process.cwd(),
    clientFactory: trackingFactory(track),
  });
  assert.equal(out.sessionId, knownId);
  assert.equal(out.resumed, true);
  assert.equal(track.promptSessionId, knownId);
  assert.equal(out.stopReason, undefined);
  assert.equal(out.result, "done");
});

test("runDelegate falls back to a fresh session when session/load fails", async () => {
  const out = await runDelegate({
    spec: "start over",
    mode: "agent",
    resumeSessionId: "unknown",
    workspace: process.cwd(),
    clientFactory: fakeFactory,
  });
  assert.equal(out.resumed, undefined);
  assert.equal(out.sessionId, "sess-1");
  assert.notEqual(out.sessionId, "unknown");
  assert.equal(out.stopReason, undefined);
});

function replayHistoryFactory() {
  return ({ onElicit, mode, onCreatePlan }) => {
    const client = fakeFactory({ onElicit, mode, onCreatePlan });
    const origLoad = client.loadSession.bind(client);
    client.loadSession = async (sessionId, cwd) => {
      const res = await origLoad(sessionId, cwd);
      client.emit("update", {
        update: { sessionUpdate: "agent_message_chunk", content: { text: "PRIOR " } },
      });
      client.emit("update", {
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "stale replayed plan", priority: "low", status: "pending" }],
        },
      });
      return res;
    };
    client.prompt = async () => {
      client.emit("update", {
        update: { sessionUpdate: "agent_message_chunk", content: { text: "NEW" } },
      });
      return { stopReason: "end_turn" };
    };
    return client;
  };
}

test("runDelegate resumed result excludes replayed session history", async () => {
  const out = await runDelegate({
    spec: "continue",
    mode: "agent",
    resumeSessionId: "sess-resumed",
    workspace: process.cwd(),
    clientFactory: replayHistoryFactory(),
  });
  assert.equal(out.resumed, true);
  assert.equal(out.result, "NEW");
  assert.ok(!out.result.includes("PRIOR "));
  assert.equal(out.plan, undefined);
});

function promptTextFactory(track) {
  return ({ onElicit, mode, onCreatePlan }) => {
    const client = fakeFactory({ onElicit, mode, onCreatePlan });
    const origPrompt = client.prompt.bind(client);
    client.prompt = async (sessionId, blocks) => {
      track.blocks = blocks;
      track.promptText = blocks.find((b) => b.type === "text")?.text;
      return origPrompt(sessionId, blocks);
    };
    return client;
  };
}

test("runDelegate sends only a text block when no contextFiles are given", async () => {
  const track = {};
  await runDelegate({ spec: "do it", mode: "agent", workspace: process.cwd(), clientFactory: promptTextFactory(track) });
  assert.deepEqual(track.blocks, [{ type: "text", text: "do it" }]);
});

test("runDelegate attaches contextFiles as resource_link blocks", async () => {
  const track = {};
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", path.join(process.cwd(), "src", "delegate.js")],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.blocks[0].type, "text");
  const links = track.blocks.slice(1);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.type), ["resource_link", "resource_link"]);
  assert.deepEqual(links.map((l) => l.name), ["package.json", "delegate.js"]);
  // Relative entries resolve against workspace, and both arrive as absolute file:// URIs.
  assert.ok(links.every((l) => l.uri.startsWith("file:///")), JSON.stringify(links));
  assert.match(links[0].uri, /\/package\.json$/);
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate deduplicates contextFiles that resolve to the same path", async () => {
  const track = {};
  const abs = path.join(process.cwd(), "package.json");
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", "package.json", "./package.json", abs],
    clientFactory: promptTextFactory(track),
  });
  const links = track.blocks.slice(1);
  assert.equal(links.length, 1, "equivalent entries collapse to one link");
  assert.match(links[0].uri, /\/package\.json$/);
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate reports a missing contextFile instead of linking or failing", async () => {
  const track = {};
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", "no-such-file-here.txt"],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(out.stopReason, undefined);
  assert.equal(track.blocks.length, 2, "the missing file must not be linked");
  assert.ok(out.protocolWarnings.some((w) => /contextFile no-such-file-here\.txt skipped: not found/.test(w)));
});

test("runDelegate skips a contextFile that is a directory", async () => {
  const track = {};
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["src"],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.blocks.length, 1);
  assert.ok(out.protocolWarnings.some((w) => /contextFile src skipped: not a file/.test(w)));
});

// Smallest valid PNG bytes; only the extension and the capability gate are under test.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function imageCapableFactory(track, { image = true } = {}) {
  return ({ onElicit, mode, onCreatePlan }) => {
    const client = fakeFactory({ onElicit, mode, onCreatePlan });
    const origInit = client.initialize.bind(client);
    client.initialize = async () => {
      const res = await origInit();
      client.agentCapabilities = { promptCapabilities: { image } };
      return res;
    };
    const origPrompt = client.prompt.bind(client);
    client.prompt = async (sessionId, blocks) => {
      track.blocks = blocks;
      return origPrompt(sessionId, blocks);
    };
    return client;
  };
}

test("runDelegate sends an image contextFile inline when the agent accepts images", async () => {
  const imgPath = path.join(tmpdir(), `delegate-img-${process.pid}.png`);
  writeFileSync(imgPath, TINY_PNG);
  const track = {};
  try {
    const out = await runDelegate({
      spec: "look at this", mode: "agent", workspace: process.cwd(),
      contextFiles: [imgPath], clientFactory: imageCapableFactory(track),
    });
    assert.equal(track.blocks.length, 2);
    assert.equal(track.blocks[1].type, "image");
    assert.equal(track.blocks[1].mimeType, "image/png");
    assert.equal(track.blocks[1].data, TINY_PNG.toString("base64"));
    assert.equal(out.protocolWarnings, undefined);
  } finally {
    try { unlinkSync(imgPath); } catch {}
  }
});

test("runDelegate skips an image when the agent does not advertise image prompts", async () => {
  const imgPath = path.join(tmpdir(), `delegate-img-nocap-${process.pid}.png`);
  writeFileSync(imgPath, TINY_PNG);
  const track = {};
  try {
    const out = await runDelegate({
      spec: "look at this", mode: "agent", workspace: process.cwd(),
      contextFiles: [imgPath], clientFactory: imageCapableFactory(track, { image: false }),
    });
    // Silently sending it would vanish without error, so it must be dropped and reported.
    assert.equal(track.blocks.length, 1);
    assert.ok(out.protocolWarnings.some((w) => /does not accept image prompts/.test(w)));
  } finally {
    try { unlinkSync(imgPath); } catch {}
  }
});

test("runDelegate reads the spec from a file when spec is an existing path", async () => {
  const specPath = path.join(tmpdir(), `delegate-spec-${process.pid}.md`);
  const brief = "# Brief\n\nDo the persisted thing.\n";
  writeFileSync(specPath, brief);
  const track = {};
  try {
    await runDelegate({
      spec: specPath,
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: promptTextFactory(track),
    });
    assert.equal(track.promptText, brief, "prompt must carry the file contents, not the path");
  } finally {
    try { unlinkSync(specPath); } catch {}
  }
});

test("runDelegate rejects a workspace that does not exist", async () => {
  const track = {};
  await assert.rejects(
    runDelegate({
      spec: "do it",
      mode: "agent",
      workspace: path.join(process.cwd(), "no_such_dir_12345"),
      clientFactory: promptTextFactory(track),
    }),
    (err) => err.reason === "invalid-workspace" && /does not exist/.test(err.message),
  );
  assert.equal(track.promptText, undefined, "rejected before the agent was spawned");
});

test("runDelegate rejects a workspace that is a file", async () => {
  await assert.rejects(
    runDelegate({
      spec: "do it",
      mode: "agent",
      workspace: fileURLToPath(import.meta.url),
      clientFactory: promptTextFactory({}),
    }),
    (err) => err.reason === "invalid-workspace" && /is not a directory/.test(err.message),
  );
});

test("runDelegate rejects a bare spec path that does not exist", async () => {
  const track = {};
  await assert.rejects(
    runDelegate({
      spec: "missing/brief.md",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: promptTextFactory(track),
    }),
    (err) => err.reason === "invalid-spec" && /nothing exists at/.test(err.message),
  );
  assert.equal(track.promptText, undefined, "rejected before the agent was prompted");
});

test("runDelegate rejects a bare spec path that is a directory", async () => {
  await assert.rejects(
    runDelegate({
      spec: process.cwd(),
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: promptTextFactory({}),
    }),
    (err) => err.reason === "invalid-spec" && /is not a file/.test(err.message),
  );
});

test("runDelegate rejects a blank spec before spending a session", async () => {
  const track = {};
  await assert.rejects(
    runDelegate({
      spec: "   \n\t ",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: promptTextFactory(track),
    }),
    (err) => err.reason === "invalid-spec" && /empty/.test(err.message),
  );
  assert.equal(track.promptText, undefined, "rejected before the agent was spawned");
});

test("runDelegate still sends prose that merely names a missing path", async () => {
  const track = {};
  await runDelegate({
    spec: "fix the bug in missing/brief.md",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.promptText, "fix the bug in missing/brief.md");
});

function askingFactory() {
  return ({ onElicit }) => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-ask" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      await onElicit({
        kind: "ask_question",
        questions: [
          { id: "q1", prompt: "Which database?", options: [{ id: "a", label: "Postgres" }] },
          { id: "q2", prompt: "Which region?", options: [{ id: "b", label: "eu-west" }] },
        ],
      });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

test("runDelegate records clarifying-question prompts in questionsAsked", async () => {
  const out = await runDelegate({
    spec: "task",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: askingFactory(),
    onElicit: async () => null,
  });
  assert.deepEqual(out.questionsAsked, ["Which database?", "Which region?"]);
});

function exitDuringPromptFactory() {
  return ({ onElicit, mode, onCreatePlan }) => {
    const client = fakeFactory({ onElicit, mode, onCreatePlan });
    client.prompt = () => new Promise(() => {
      client.emit("exit", { code: 1, signal: null, stderr: "boom-trace" });
    });
    return client;
  };
}

test("runDelegate rejects promptly when agent exits during prompt", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "do the thing",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: exitDuringPromptFactory(),
    }),
    (err) => {
      assert.equal(err.reason, "agent-exit");
      assert.match(err.message, /agent exited \(code=1\)/);
      assert.match(err.message, /boom-trace/);
      return true;
    }
  );
  assert.ok(Date.now() - start < 2000, "expected fail-fast rejection, not full timeout");
});

test("runDelegate truncates accumulated output at 10MB", async () => {
  const marker = "\n\n[output truncated at 10MB]";
  const maxOutput = 10 * 1024 * 1024;
  const out = await runDelegate({
    spec: "big task",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: () => oversizedFactory(),
  });
  assert.ok(out.result.endsWith(marker));
  assert.equal(out.result.length, maxOutput + marker.length);
});

test("runDelegate cuts the 10MB output at a code-point boundary", async () => {
  const marker = "\n\n[output truncated at 10MB]";
  const maxOutput = 10 * 1024 * 1024;
  const out = await runDelegate({
    spec: "big emoji task",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: () => surrogateBoundaryFactory(),
  });
  assert.ok(out.result.endsWith(marker));
  assert.ok(out.result.isWellFormed(), "result must not contain a lone surrogate");
  // Stepped back one unit off the surrogate pair, so one short of the raw cap.
  assert.equal(out.result.length, maxOutput - 1 + marker.length);
});

function failingPromptFactory() {
  return ({ onElicit, mode, onCreatePlan }) => {
    const client = fakeFactory({ onElicit, mode, onCreatePlan });
    client.prompt = async () => { throw new Error("prompt failed"); };
    return client;
  };
}

test("runDelegate leaves the ACP transcript out of the error by default", async () => {
  delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
  await assert.rejects(
    () => runDelegate({
      spec: "do the thing",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: failingPromptFactory(),
    }),
    (err) => {
      assert.match(err.message, /prompt failed/);
      assert.doesNotMatch(err.message, /recent ACP transcript/);
      return true;
    }
  );
});

test("runDelegate appends the transcript when CURSOR_DELEGATE_TRANSCRIPT is set", async () => {
  process.env.CURSOR_DELEGATE_TRANSCRIPT = "12";
  try {
    await assert.rejects(
      () => runDelegate({
        spec: "do the thing",
        mode: "agent",
        workspace: process.cwd(),
        clientFactory: failingPromptFactory(),
      }),
      (err) => {
        assert.match(err.message, /prompt failed/);
        assert.match(err.message, /--- recent ACP transcript \(last 12 frames\) ---/);
        assert.match(err.message, / out /);
        assert.match(err.message, / in /);
        return true;
      }
    );
  } finally {
    delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
  }
});

function scriptedFactory({ planEntries, stopReason = "end_turn", message = "plan ready" }) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-scripted" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      if (planEntries) client.emit("update", { update: { sessionUpdate: "plan", entries: planEntries } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: message } } });
      return { stopReason };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

test("runDelegate sanitizes malformed ACP plan frames instead of surfacing them", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({
      planEntries: [
        { content: "valid step", priority: "high", status: "pending" },
        { content: { text: "object content violates ACP" } },
        { content: "loose fields", priority: "urgent", status: "done" },
      ],
    }),
  });
  assert.equal(out.result, "plan ready");
  assert.equal(out.stopReason, undefined);
  assert.deepEqual(out.plan.entries, [
    { content: "valid step", priority: "high", status: "pending" },
    { content: "loose fields" },
  ]);
  assert.equal(out.protocolWarnings.length, 3);
  assert.match(out.protocolWarnings[0], /plan entry 1 dropped/);
  assert.match(out.protocolWarnings[1], /priority/);
  assert.match(out.protocolWarnings[2], /status/);
});

test("runDelegate surfaces a stop reason that is not end_turn", async () => {
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({ stopReason: "refusal", message: "no" }),
  });
  assert.equal(out.stopReason, "refusal");
});

test("runDelegate drops a non-string stopReason with a protocol warning", async () => {
  const out = await runDelegate({
    spec: "do the thing",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({ stopReason: { code: 7 }, message: "done" }),
  });
  assert.equal(out.stopReason, undefined);
  assert.equal(out.result, "done");
  assert.deepEqual(out.protocolWarnings, ["stopReason dropped: ACP requires a string stop reason"]);
});

test("runDelegate omits protocolWarnings when frames are well-formed", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({ planEntries: [{ content: "ok", priority: "low", status: "completed" }] }),
  });
  assert.equal(out.protocolWarnings, undefined);
  assert.deepEqual(out.plan.entries, [{ content: "ok", priority: "low", status: "completed" }]);
});

function abortablePromptFactory({ onAbortReady, track }) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-abort" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.on = (...args) => EventEmitter.prototype.on.call(client, ...args);
    client.off = (...args) => EventEmitter.prototype.off.call(client, ...args);
    client.cancel = async () => {};
    client.child = { pid: null, exitCode: null, signalCode: null, kill() {} };
    client.prompt = () => new Promise((resolve) => { onAbortReady?.(resolve); });
    client.getTranscript = () => "";
    client.stop = () => { track.stopped = true; };
    return client;
  };
}

test("runDelegate rejects with aborted when signal fires during prompt", async () => {
  const track = {};
  const ac = new AbortController();
  let resolvePrompt;
  const run = runDelegate({
    spec: "task",
    mode: "agent",
    workspace: process.cwd(),
    signal: ac.signal,
    clientFactory: abortablePromptFactory({
      track,
      onAbortReady: (resolve) => { resolvePrompt = resolve; },
    }),
  });
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await assert.rejects(run, (err) => {
    assert.equal(err.reason, "aborted");
    return true;
  });
  assert.equal(track.stopped, true);
  resolvePrompt?.({ stopReason: "end_turn" });
});

test("runDelegate rejects immediately when signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  let factoryCalls = 0;
  await assert.rejects(
    () => runDelegate({
      spec: "task",
      mode: "agent",
      workspace: process.cwd(),
      signal: ac.signal,
      clientFactory: () => { factoryCalls++; return new EventEmitter(); },
    }),
    (err) => {
      assert.equal(err.reason, "aborted");
      return true;
    }
  );
  assert.equal(factoryCalls, 0);
});

// Frames replayed from docs/acp-probes/2026-07-22-todo-stream/02-raw-multistep.txt:
// one merge:false full list, then merge:true deltas carrying only the changed entries.
function todoFactory(frames) {
  return ({ onTodos }) => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-todo" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      for (const f of frames) onTodos(f);
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

const MEASURED_TODO_FRAMES = [
  { merge: false, todos: [
    { id: "1", content: "Create b1.txt containing 'b1'", status: "in_progress" },
    { id: "2", content: "Create b2.txt containing 'b2'", status: "pending" },
    { id: "3", content: "Create b3.txt containing 'b3'", status: "pending" },
  ] },
  { merge: true, todos: [
    { id: "1", content: "Create b1.txt containing 'b1'", status: "completed" },
    { id: "2", content: "Create b2.txt containing 'b2'", status: "in_progress" },
  ] },
  { merge: true, todos: [
    { id: "2", content: "Create b2.txt containing 'b2'", status: "completed" },
    { id: "3", content: "Create b3.txt containing 'b3'", status: "in_progress" },
  ] },
  { merge: true, todos: [
    { id: "3", content: "Create b3.txt containing 'b3'", status: "completed" },
  ] },
];

test("runDelegate reports a fully-completed todo stream as counts only", async () => {
  const out = await runDelegate({
    spec: "three steps",
    workspace: process.cwd(),
    clientFactory: todoFactory(MEASURED_TODO_FRAMES),
  });
  // The full list on a 3/3 turn restates the counts entry by entry — counts carry it alone.
  assert.equal(out.todos, undefined);
  assert.deepEqual(out.todoProgress, { total: 3, completed: 3, inProgress: 0, pending: 0 });
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate reports a turn that ends with todos still pending", async () => {
  const out = await runDelegate({
    spec: "three steps",
    workspace: process.cwd(),
    clientFactory: todoFactory(MEASURED_TODO_FRAMES.slice(0, 2)),
  });
  assert.equal(out.stopReason, undefined);
  assert.deepEqual(out.todoProgress, { total: 3, completed: 1, inProgress: 1, pending: 1 });
  // Unfinished work is when the list earns its place: it names what remains.
  assert.equal(out.todos.length, 3);
  assert.deepEqual(out.todos.map((t) => t.status), ["completed", "in_progress", "pending"]);
});

test("runDelegate omits todo fields when the agent tracked none", async () => {
  const out = await runDelegate({
    spec: "one small thing",
    workspace: process.cwd(),
    clientFactory: todoFactory([]),
  });
  assert.equal(out.todos, undefined);
  assert.equal(out.todoProgress, undefined);
});

test("runDelegate keeps merge:true entries whose id was never seen before", async () => {
  const out = await runDelegate({
    spec: "three steps",
    workspace: process.cwd(),
    clientFactory: todoFactory([{ merge: true, todos: [{ id: "9", content: "late arrival", status: "pending" }] }]),
  });
  assert.deepEqual(out.todos, [{ id: "9", content: "late arrival", status: "pending" }]);
  assert.deepEqual(out.todoProgress, { total: 1, completed: 0, inProgress: 0, pending: 1 });
});

test("runDelegate treats merge:false as a full replacement", async () => {
  const out = await runDelegate({
    spec: "replan",
    workspace: process.cwd(),
    clientFactory: todoFactory([
      { merge: false, todos: [{ id: "1", content: "first", status: "completed" }] },
      { merge: false, todos: [{ id: "2", content: "second", status: "pending" }] },
    ]),
  });
  assert.deepEqual(out.todos, [{ id: "2", content: "second", status: "pending" }]);
});

test("runDelegate sanitizes malformed todo entries instead of failing the call", async () => {
  const out = await runDelegate({
    spec: "three steps",
    workspace: process.cwd(),
    clientFactory: todoFactory([{ merge: false, todos: [
      { id: "1", content: "keep me", status: "pending" },
      { id: "2", content: { text: "object content" }, status: "pending" },
      { id: "3", content: "odd status", status: "abandoned" },
    ] }]),
  });
  assert.deepEqual(out.todos, [
    { id: "1", content: "keep me", status: "pending" },
    { id: "3", content: "odd status" },
  ]);
  assert.equal(out.todoProgress.total, 2);
  assert.equal(out.protocolWarnings.length, 2);
  assert.match(out.protocolWarnings[0], /todo 1 dropped/);
  assert.match(out.protocolWarnings[1], /abandoned/);
});

test("runDelegate collects type:content blocks emitted after tools finish", async () => {
  const factory = () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-content" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", status: "pending" } });
      client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
        content: [{ type: "content", content: { type: "text", text: "streamed output" } }] } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
  const out = await runDelegate({ spec: "run it", workspace: process.cwd(), clientFactory: factory });
  assert.equal(out.result, "streamed output");
});

test("runDelegate streams todo progress as it arrives", async () => {
  const seen = [];
  await runDelegate({
    spec: "three steps",
    workspace: process.cwd(),
    clientFactory: todoFactory(MEASURED_TODO_FRAMES),
    onProgress: (m) => seen.push(m),
  });
  const todoMessages = seen.filter((m) => m.startsWith("todo"));
  assert.deepEqual(todoMessages, [
    "todo 1/3: Create b1.txt containing 'b1'",
    "todo 2/3: Create b2.txt containing 'b2'",
    "todo 3/3: Create b3.txt containing 'b3'",
    "todos 3/3 complete",
  ]);
});

test("todo progress messages are omitted when the agent tracks none", async () => {
  const seen = [];
  await runDelegate({
    spec: "one small thing",
    workspace: process.cwd(),
    clientFactory: todoFactory([]),
    onProgress: (m) => seen.push(m),
  });
  assert.equal(seen.filter((m) => m.startsWith("todo")).length, 0);
});

test("heartbeat names the in-progress todo during a silent turn", async () => {
  const lines = [];
  const factory = ({ onTodos }) => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-hb" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = () => {
      onTodos({ merge: false, todos: [
        { id: "1", content: "Set up fixtures", status: "completed" },
        { id: "2", content: "Run integration tests", status: "in_progress" },
      ] });
      return new Promise(() => {});
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: factory,
      handshakeMs: 10000,
      hardCapMs: 700,
      heartbeatMs: 100,
      onProgress: (m) => lines.push(m),
    }),
    (err) => err.reason === "hard-cap"
  );
  const beats = lines.filter((l) => l.startsWith("still working"));
  assert.ok(beats.length >= 2, `expected repeated heartbeats, got ${JSON.stringify(beats)}`);
  assert.match(beats[0], /todo 2\/2: Run integration tests/);
});

function hangingFactory({ todos: frames = [], emit, title, loadFails } = {}) {
  return ({ onTodos }) => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-forensics" });
    client.loadSession = async () => {
      if (loadFails) throw rpcError(-32602, "Invalid params: Session stale-id not found");
    };
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.cancel = async () => {};
    client.prompt = () => {
      if (title) client.emit("update", { update: { sessionUpdate: "session_info_update", title } });
      for (const f of frames) onTodos(f);
      emit?.(client);
      return new Promise(() => {});
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

test("hard-cap error reports todo progress, files touched and the resume id", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: hangingFactory({
        todos: MEASURED_TODO_FRAMES.slice(0, 2),
        emit: (client) => client.emit("update", { update: {
          sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress",
          content: [{ type: "diff", path: "b1.txt" }],
        } }),
      }),
      handshakeMs: 10000,
      hardCapMs: 300,
      heartbeatMs: 0,
    }),
    (err) => {
      assert.equal(err.reason, "hard-cap");
      assert.match(err.message, /1 of 3 todos completed/);
      assert.match(err.message, /todo 2\/3: Create b2\.txt/);
      assert.match(err.message, /Files reported edited: b1\.txt/);
      assert.match(err.message, /Resume with resumeSessionId sess-forensics/);
      assert.match(err.message, /raise CURSOR_DELEGATE_HARD_CAP_MS/);
      return true;
    }
  );
});

// The advice must name the knob that fired: raising the hard cap does nothing when the
// idle guard tripped.
test("idle-timeout error advises CURSOR_DELEGATE_IDLE_MS, not the hard cap", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: hangingFactory(),
      handshakeMs: 10000,
      idleMs: 300,
      heartbeatMs: 0,
    }),
    (err) => {
      assert.equal(err.reason, "idle-timeout");
      assert.match(err.message, /raise CURSOR_DELEGATE_IDLE_MS/);
      assert.ok(!/CURSOR_DELEGATE_HARD_CAP_MS/.test(err.message), "the hard cap is the wrong knob here");
      return true;
    }
  );
});

test("timeout error names the turn and a resume that had already failed", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      resumeSessionId: "stale-id",
      workspace: process.cwd(),
      clientFactory: hangingFactory({ title: "Auth Refactor", loadFails: true }),
      handshakeMs: 10000,
      hardCapMs: 300,
      heartbeatMs: 0,
    }),
    (err) => {
      assert.match(err.message, /titled this turn "Auth Refactor"/);
      assert.match(err.message, /resuming stale-id had already failed \(.*Session stale-id not found\)/);
      assert.match(err.message, /none of that earlier work was in context/);
      assert.match(err.message, /Resume with resumeSessionId sess-forensics/);
      return true;
    }
  );
});

test("timeout error stays quiet about resume and title when neither applies", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: hangingFactory(),
      handshakeMs: 10000,
      hardCapMs: 300,
      heartbeatMs: 0,
    }),
    (err) => {
      assert.doesNotMatch(err.message, /titled this turn/);
      assert.doesNotMatch(err.message, /had already failed/);
      return true;
    }
  );
});

test("aborted error carries the same forensics as a timeout", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: hangingFactory({ todos: MEASURED_TODO_FRAMES.slice(0, 1) }),
      handshakeMs: 10000,
      hardCapMs: 10000,
      heartbeatMs: 0,
      signal: controller.signal,
    }),
    (err) => {
      assert.equal(err.reason, "aborted");
      assert.match(err.message, /0 of 3 todos completed/);
      assert.match(err.message, /Resume with resumeSessionId sess-forensics/);
      assert.doesNotMatch(err.message, /does not stream shell output/);
      return true;
    }
  );
});

test("timeout forensics stay quiet when the agent tracked no todos", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      workspace: process.cwd(),
      clientFactory: hangingFactory(),
      handshakeMs: 10000,
      hardCapMs: 300,
      heartbeatMs: 0,
    }),
    (err) => {
      assert.doesNotMatch(err.message, /todos completed/);
      assert.doesNotMatch(err.message, /Files reported edited/);
      assert.match(err.message, /does not stream shell output/);
      return true;
    }
  );
});

function modelListFactory(availableModels) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => {
      if (availableModels !== undefined) client.sessionModels = { availableModels };
      return { sessionId: "sess-models" };
    };
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

test("runDelegate rejects an unknown model and names the agent's real list", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "go",
      workspace: process.cwd(),
      model: "gpt-9-imaginary",
      clientFactory: modelListFactory([{ modelId: "composer-2.5" }, { modelId: "claude-opus-4-8" }]),
    }),
    (err) => {
      assert.equal(err.reason, "unknown-model");
      assert.match(err.message, /Unknown model "gpt-9-imaginary"/);
      assert.match(err.message, /composer-2\.5, claude-opus-4-8/);
      return true;
    }
  );
});

test("runDelegate accepts a model the agent advertises", async () => {
  const out = await runDelegate({
    spec: "go",
    workspace: process.cwd(),
    model: "claude-opus-4-8",
    clientFactory: modelListFactory([{ modelId: "composer-2.5" }, { modelId: "claude-opus-4-8" }]),
  });
  assert.equal(out.result, "ok");
});

test("runDelegate skips model validation when the agent advertises no list", async () => {
  const out = await runDelegate({
    spec: "go",
    workspace: process.cwd(),
    model: "anything-goes",
    clientFactory: modelListFactory(undefined),
  });
  assert.equal(out.result, "ok");
});

function modeFactory(modeIds) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-mode" });
    client.setModel = async () => {};
    client.setConfigOption = async () => {};
    client.setMode = async () => {};
    client.prompt = async () => {
      for (const id of modeIds) {
        client.emit("update", { update: { sessionUpdate: "current_mode_update", currentModeId: id } });
      }
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } });
      return { stopReason: "end_turn" };
    };
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

// A plan run that writes through the shell emits one execute tool call and no
// current_mode_update: the mode is ignored without ever being left.
const execCall = (title) => ({ sessionUpdate: "tool_call", toolCallId: "x1", kind: "execute", title, status: "pending" });

test("runDelegate reports write-capable tool calls made during a plan turn", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: replayFactory([
      execCall("`echo LEAKED > leak.txt`"),
      toolUpdate("x1", "completed"),
      msgChunk("Wrote the file."),
    ]),
  });
  assert.deepEqual(out.writeCapableActivity, [{ kind: "execute", detail: "`echo LEAKED > leak.txt`" }]);
  assert.ok(out.protocolWarnings.some((w) => /write-capable tool call/.test(w)));
  // A pathless execute may be a read-only command, so the warning must not assert a change.
  assert.ok(out.protocolWarnings.some((w) => /none reported touching a file/.test(w)));
  assert.ok(!out.protocolWarnings.some((w) => /the diff for what changed/.test(w)));
  assert.equal(out.modeChanged, undefined, "the agent never left plan mode, so nothing drifted");
});

// An edit tool_call carries title "Edit File" and no locations, so the file it touched is
// only knowable from the diff frame that follows.
test("runDelegate names the file an edit-kind plan write touched", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: replayFactory([
      { sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", title: "Edit File", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed",
        content: [{ type: "diff", path: path.join(process.cwd(), "docs", "plan.md") }] },
      msgChunk("Saved the plan."),
    ]),
  });
  assert.deepEqual(out.writeCapableActivity, [{ kind: "edit", detail: "Edit File", path: "docs/plan.md" }]);
  // A reported path is evidence something changed, so here the warning points at the diff.
  assert.ok(out.protocolWarnings.some((w) => /the diff for what changed/.test(w)));
});

// A rename arrives as an edit/delete pair rather than a move-kind call; delete carries a
// diff frame naming the file it removed.
test("runDelegate names the file a delete-kind plan write removed", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: replayFactory([
      { sessionUpdate: "tool_call", toolCallId: "d1", kind: "delete", title: "Delete File", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "d1", status: "completed",
        content: [{ type: "diff", path: "old.txt" }] },
      msgChunk("Removed it."),
    ]),
  });
  assert.deepEqual(out.writeCapableActivity, [{ kind: "delete", detail: "Delete File", path: "old.txt" }]);
});

// An edit call does not always emit a diff frame, and a pathless entry is not evidence that
// a write landed: no-ops and retries produce one too, and in a rename the diff frames account
// for the whole net change on disk while the diffless edits account for none of it. The entry
// stays because a missing diff frame is not proof nothing happened — it claims a write-capable
// tool ran, which is all this field ever claims.
test("runDelegate reports an edit-kind tool call that never emits a diff", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: replayFactory([
      { sessionUpdate: "tool_call", toolCallId: "e9", kind: "edit", title: "Edit File", status: "pending" },
      toolUpdate("e9", "completed"),
      msgChunk("Done."),
    ]),
  });
  assert.deepEqual(out.writeCapableActivity, [{ kind: "edit", detail: "Edit File" }]);
  assert.equal(out.filesReportedByEditTools, undefined, "no diff frame, so the edit-tool channel saw nothing");
});

test("runDelegate stays quiet about write-capable tool calls in agent mode", async () => {
  const out = await runDelegate({
    spec: "do it",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: replayFactory([execCall("`npm test`"), toolUpdate("x1", "completed"), msgChunk("Done.")]),
  });
  assert.equal(out.writeCapableActivity, undefined, "every agent turn does this; it would carry no signal");
});

test("runDelegate does not flag read-only tool calls in a plan turn", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: replayFactory([
      { sessionUpdate: "tool_call", toolCallId: "r1", kind: "read", title: "Read File", status: "pending" },
      toolUpdate("r1", "completed"),
      msgChunk("Here is the plan."),
    ]),
  });
  assert.equal(out.writeCapableActivity, undefined);
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate flags a mode switch away from the requested mode", async () => {
  const out = await runDelegate({
    spec: "plan it",
    mode: "plan",
    workspace: process.cwd(),
    clientFactory: modeFactory(["plan", "agent"]),
  });
  assert.deepEqual(out.modeChanged, { from: "plan", to: "agent" });
  assert.match(out.protocolWarnings[0], /switched mode from plan to agent/);
});

test("runDelegate stays quiet when the reported mode matches the request", async () => {
  const out = await runDelegate({
    spec: "do it",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: modeFactory(["agent", "agent"]),
  });
  assert.equal(out.modeChanged, undefined);
  assert.equal(out.protocolWarnings, undefined);
});

// session/load replays the previous turn: measured 23 frames, incl. tool_call with
// synthetic "replay-0-N" ids and tool_call_update carrying real diff blocks.
function loadReplayFactory() {
  const client = new EventEmitter();
  const replay = () => {
    client.emit("update", { update: { sessionUpdate: "user_message_chunk", content: { text: "earlier request" } } });
    client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "replay-0-2", title: "Edit File", status: "pending" } });
    client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "replay-0-2", status: "completed",
      content: [{ type: "diff", path: "from-a-previous-turn.txt" }] } });
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "stale result text" } } });
  };
  client.start = async () => {};
  client.initialize = async () => {};
  client.newSession = async () => ({ sessionId: "sess-new" });
  client.loadSession = async () => { replay(); return {}; };
  client.setModel = async () => {};
  client.setConfigOption = async () => {};
  client.setMode = async () => {};
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "fresh answer" } } });
    return { stopReason: "end_turn" };
  };
  client.getTranscript = () => "";
  client.stop = () => {};
  return () => client;
}

test("replayed session/load frames do not leak into the result or touched files", async () => {
  const progress = [];
  const out = await runDelegate({
    spec: "continue",
    workspace: process.cwd(),
    resumeSessionId: "sess-old",
    clientFactory: loadReplayFactory(),
    onProgress: (m) => progress.push(m),
  });
  // The reset before the prompt cannot unsend a notification, so replayed frames must
  // never reach onProgress in the first place.
  assert.deepEqual(progress.filter((m) => /Edit File|from-a-previous-turn/.test(m)), []);
  assert.equal(out.result, "fresh answer");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.filesReportedByEditTools, undefined, "replayed diff frames must not surface as this turn's edits");
  assert.equal(out.resumed, true);
});
