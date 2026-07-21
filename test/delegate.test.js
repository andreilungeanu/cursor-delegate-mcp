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
    client.setFast = async () => {};
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
  client.setFast = async () => {};
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

function fastToggleFactory({ onSetFast }) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-track" });
    client.setModel = async () => {};
    client.setFast = async (_sid, value) => onSetFast?.(value);
    client.setMode = async () => {};
    client.prompt = async () => ({ stopReason: "end_turn" });
    client.getTranscript = () => "";
    client.stop = () => {};
    return client;
  };
}

test("runDelegate returns assembled result for a fresh session", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.stopReason, "end_turn");
  assert.equal(out.sessionId, "sess-1");
  assert.equal(out.result, "done");
  assert.equal(out.resultSource, "post-tool");
  assert.equal(out.finalMessageAvailable, true);
  assert.deepEqual(out.questionsAsked, []);
  assert.equal(out.resumed, false);
  assert.equal(out.plan, undefined);
});

test("runDelegate calls setFast only for Composer bare model ids", async () => {
  let fastCalls = 0;
  await runDelegate({
    spec: "task",
    model: "gpt-5",
    fast: true,
    workspace: process.cwd(),
    clientFactory: fastToggleFactory({ onSetFast: () => { fastCalls++; } }),
  });
  assert.equal(fastCalls, 0);

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

test("runDelegate captures session/update:plan with latest update winning", async () => {
  const out = await runDelegate({ spec: "draft a plan", mode: "plan", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.stopReason, "end_turn");
  assert.equal(out.result, "plan ready");
  assert.ok(out.plan);
  assert.deepEqual(out.plan.entries, [
    { content: "Create CHANGELOG.md", priority: "medium", status: "pending" },
  ]);
  assert.equal(out.plan.overview, "Add a changelog file");
  assert.equal(out.plan.detail, "# Plan\n\n1. Create CHANGELOG.md");
  assert.deepEqual(out.filesReportedByAgent, []);
});

test("runDelegate plan-mode filesReportedByAgent is empty (no diff events)", async () => {
  const out = await runDelegate({ spec: "draft a plan", mode: "plan", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.deepEqual(out.filesReportedByAgent, []);
});

test("runDelegate omits plan when no plan was emitted", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.plan, undefined);
});

test("runDelegate populates filesReportedByAgent from a tool_call_update diff (real-agent shape)", async () => {
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.deepEqual(out.filesReportedByAgent, ["hello.txt"]);
});

test("runDelegate reports diff-event paths in a non-git workspace", async () => {
  // Attribution comes only from native ACP diff events, so git state is irrelevant.
  const out = await runDelegate({ spec: "do the thing", mode: "agent", workspace: tmpdir(), clientFactory: fakeFactory });
  assert.deepEqual(out.filesReportedByAgent, ["hello.txt"]);
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
  client.setFast = async () => {};
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
  assert.equal(out.resultSource, "tool-free-stream");
  assert.equal(out.finalMessageAvailable, true);
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
  assert.equal(out.resultSource, "post-tool");
  assert.equal(out.finalMessageAvailable, true);
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
  assert.equal(out.resultSource, "post-tool");
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
  assert.equal(out.resultSource, "post-tool");
});

test("runDelegate reports no final message instead of inventing a fallback", async () => {
  const out = await replayResult([
    msgChunk("I will make the edit."),
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
  ]);
  assert.equal(out.result, "");
  assert.equal(out.resultSource, "none");
  assert.equal(out.finalMessageAvailable, false);
});

test("runDelegate keeps the final message when a duplicate terminal tool update arrives late", async () => {
  const out = await replayResult([
    toolCall("edit-1"),
    toolUpdate("edit-1", "completed"),
    msgChunk("Fixed the parser and added a regression test."),
    toolUpdate("edit-1", "completed"),
  ]);
  assert.equal(out.result, "Fixed the parser and added a regression test.");
  assert.equal(out.resultSource, "post-tool");
  assert.equal(out.finalMessageAvailable, true);
});

test("runDelegate preserves a legitimate code-only final response", async () => {
  const code = "```js\nexport const answer = 42;\n```";
  const out = await replayResult([
    toolCall("read-1"),
    toolUpdate("read-1", "completed"),
    msgChunk(code),
  ]);
  assert.equal(out.result, code);
  assert.equal(out.resultSource, "post-tool");
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
  assert.equal(out.stopReason, "end_turn");
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
  assert.equal(out.resumed, false);
  assert.equal(out.sessionId, "sess-1");
  assert.notEqual(out.sessionId, "unknown");
  assert.equal(out.stopReason, "end_turn");
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
    client.prompt = async (sessionId, text) => {
      track.promptText = text;
      return origPrompt(sessionId, text);
    };
    return client;
  };
}

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

test("runDelegate sends a path-looking spec literally when the file does not exist", async () => {
  const track = {};
  await runDelegate({
    spec: "missing/brief.md",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.promptText, "missing/brief.md");
});

function askingFactory() {
  return ({ onElicit }) => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-ask" });
    client.setModel = async () => {};
    client.setFast = async () => {};
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

function failingPromptFactory() {
  return ({ onElicit, mode, onCreatePlan }) => {
    const client = fakeFactory({ onElicit, mode, onCreatePlan });
    client.prompt = async () => { throw new Error("prompt failed"); };
    return client;
  };
}

test("runDelegate appends recent transcript to error on failure", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "do the thing",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: failingPromptFactory(),
    }),
    (err) => {
      assert.match(err.message, /prompt failed/);
      assert.match(err.message, /--- recent ACP transcript \(last 40 frames\) ---/);
      assert.match(err.message, / out /);
      assert.match(err.message, / in /);
      return true;
    }
  );
});

function scriptedFactory({ planEntries, stopReason = "end_turn", message = "plan ready" }) {
  return () => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-scripted" });
    client.setModel = async () => {};
    client.setFast = async () => {};
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
  assert.equal(out.stopReason, "end_turn");
  assert.deepEqual(out.plan.entries, [
    { content: "valid step", priority: "high", status: "pending" },
    { content: "loose fields" },
  ]);
  assert.equal(out.protocolWarnings.length, 3);
  assert.match(out.protocolWarnings[0], /plan entry 1 dropped/);
  assert.match(out.protocolWarnings[1], /priority/);
  assert.match(out.protocolWarnings[2], /status/);
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
    client.setFast = async () => {};
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
    client.setFast = async () => {};
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

test("runDelegate folds the measured todo stream into a completed list", async () => {
  const out = await runDelegate({
    spec: "three steps",
    workspace: process.cwd(),
    clientFactory: todoFactory(MEASURED_TODO_FRAMES),
  });
  assert.equal(out.todos.length, 3);
  assert.deepEqual(out.todos.map((t) => t.status), ["completed", "completed", "completed"]);
  assert.deepEqual(out.todoProgress, { total: 3, completed: 3, inProgress: 0, pending: 0 });
  assert.equal(out.protocolWarnings, undefined);
});

test("runDelegate reports a turn that ends with todos still pending", async () => {
  const out = await runDelegate({
    spec: "three steps",
    workspace: process.cwd(),
    clientFactory: todoFactory(MEASURED_TODO_FRAMES.slice(0, 2)),
  });
  assert.equal(out.stopReason, "end_turn");
  assert.deepEqual(out.todoProgress, { total: 3, completed: 1, inProgress: 1, pending: 1 });
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
    client.setFast = async () => {};
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
    client.setFast = async () => {};
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

function hangingFactory({ todos: frames = [], emit } = {}) {
  return ({ onTodos }) => {
    const client = new EventEmitter();
    client.start = async () => {};
    client.initialize = async () => {};
    client.newSession = async () => ({ sessionId: "sess-forensics" });
    client.setModel = async () => {};
    client.setFast = async () => {};
    client.setMode = async () => {};
    client.cancel = async () => {};
    client.prompt = () => {
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
    client.setFast = async () => {};
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
    client.setFast = async () => {};
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
  client.setFast = async () => {};
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
  assert.equal(out.resultSource, "tool-free-stream");
  assert.deepEqual(out.filesReportedByAgent, []);
  assert.equal(out.resumed, true);
});
