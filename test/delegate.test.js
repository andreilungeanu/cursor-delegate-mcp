import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AcpClient } from "../src/acp-client.js";
import { runDelegate as rawRunDelegate } from "../src/delegate.js";
import { delegateOutputShape } from "../src/server.js";

// Every result this suite produces is parsed against a strict copy of delegateOutputShape.
// Nothing else checks it: the shape is not declared to hosts, so a field added here but
// forgotten there would drift undocumented and no other test would notice.
const strictOutput = z.object(delegateOutputShape).strict();
const runDelegate = async (opts) => {
  const out = await rawRunDelegate(opts);
  strictOutput.parse(out);
  return out;
};

// A stub agent that completes an empty turn. Every factory below starts from this and
// overwrites only the methods its test exercises, so the ACP surface is declared once:
// adding a method to AcpClient means editing one place, not every stub.
function stubClient(sessionId = "sess") {
  const client = new EventEmitter();
  client.start = async () => {};
  client.initialize = async () => {};
  client.newSession = async () => ({ sessionId });
  client.setModel = async () => {};
  client.setConfigOption = async () => {};
  client.setMode = async () => {};
  client.prompt = async () => ({ stopReason: "end_turn" });
  client.getTranscript = () => "";
  client.stop = () => {};
  return client;
}

function thinkingFactory() {
  return () => {
    const client = stubClient("sess-think");
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET-THOUGHT: planning" } } });
      client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit File", kind: "edit", status: "pending" } });
      client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    };
    return client;
  };
}

function fakeFactory({ mode, onCreatePlan }) {
  return new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/fake-acp.js", import.meta.url))],
      options: { shell: false },
    },
    mode,
    onCreatePlan,
  });
}

// A real spawn, not a stub emit: the crash this covers depends on where the frame is handled.
// A stub calling client.emit() from inside prompt() has its throw caught by the prompt promise
// and only fails that delegation. Off the wire the same throw runs in the readline callback,
// where nothing is awaiting it — an uncaught exception that takes the MCP server down.
function malformedContentFactory() {
  return new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/malformed-content-acp.js", import.meta.url))],
      options: { shell: false },
    },
  });
}

// hardCapMs keeps the failure fast. Without the guard this test does not fail, it hangs: the
// throw escapes the readline callback, so the end_turn reply on the next line is never read and
// the turn runs to the cap — an hour on the default.
test("a tool_call_update whose content is an object is ignored, not fatal", async () => {
  const out = await runDelegate({ workspace: process.cwd(),
    spec: "task",
    clientFactory: malformedContentFactory,
    hardCapMs: 8000,
  });
  assert.equal(out.result, "done");
  // The frame named a path, but it arrived in a shape ACP does not define. Nothing is reported
  // rather than reaching into it, and the turn still completes.
  assert.equal(out.filesReportedByEditTools, undefined);
});

// A stub is enough here, unlike the tool_call_update case above: this frame does not throw where
// it arrives, it throws later in the result builder, which is reached identically however the
// frame was delivered. entries as a string is the shape that gets furthest — it has a .length,
// so it passes the emptiness guard and reaches the sanitizer's forEach.
function malformedPlanFactory() {
  const client = stubClient("sess-plan-bad");
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "plan", entries: "not-an-array" } });
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } });
    return { stopReason: "end_turn" };
  };
  return client;
}

test("a plan frame whose entries is not an array is reported, not fatal", async () => {
  const out = await runDelegate({ workspace: process.cwd(), spec: "task", clientFactory: malformedPlanFactory });
  // The sanitizer exists so a malformed plan frame cannot fail the call after the work is done.
  // A non-array entries defeated it by throwing before it could report anything.
  assert.equal(out.result, "done");
  assert.ok(
    out.protocolWarnings?.some((w) => /plan entries dropped/i.test(w)),
    `expected a dropped-entries warning, got ${JSON.stringify(out.protocolWarnings)}`
  );
  assert.equal(out.plan, undefined);
});

// A stale non-terminal re-send for an already-completed tool call used to restart collection,
// demoting the collected final message to discardedResult and mislabeling it pre-tool-fallback.
function staleUpdateFactory() {
  const client = stubClient("sess-stale");
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit File", kind: "edit", status: "pending" } });
    client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final" } } });
    client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" } });
    return { stopReason: "end_turn" };
  };
  return client;
}

test("a stale non-terminal update for a finished tool call keeps the final message", async () => {
  const out = await runDelegate({ workspace: process.cwd(), spec: "task", clientFactory: staleUpdateFactory });
  assert.equal(out.result, "final");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.protocolWarnings, undefined);
});

function oversizedFactory() {
  const client = stubClient("sess-big");
  client.prompt = async () => {
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 12; i++) {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: chunk } } });
    }
    return { stopReason: "end_turn" };
  };
  return client;
}

function fastToggleFactory({ onSetFast }) {
  return () => {
    const client = stubClient("sess-track");
    client.setConfigOption = async (_sid, configId, value) => onSetFast?.(value, configId);
    return client;
  };
}

// setConfigOption echoes the served model in configOptions (the measured post-set_model shape);
// rejectFast throws the -32602 a model without the fast knob returns.
function servedModelFactory({ served, rejectFast = false }) {
  return () => {
    const client = stubClient("sess-model");
    client.setConfigOption = async (_sid, configId) => {
      if (rejectFast && configId === "fast") {
        const err = new Error("Unknown model config option: fast");
        err.code = -32602;
        throw err;
      }
      return { configOptions: [{ id: "model", currentValue: served, options: [{ value: served }] }] };
    };
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } });
      return { stopReason: "end_turn" };
    };
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

// Cursor persists the tier across sessions, so the skip is keyed to the value the session reports
// opening with, never to an assumption about what a fresh session starts at.
function opensWithFastFactory(opened, onSetFast, openedOn = "composer-2.5") {
  return () => {
    const client = stubClient("sess-fast");
    client.newSession = async () => {
      client.sessionModels = { currentModelId: openedOn, availableModels: [{ modelId: "composer-2.5" }, { modelId: "grok-4.6" }] };
      client.configOptions = opened === undefined
        ? undefined
        : [{ id: "fast", currentValue: opened, options: [{ value: "false" }, { value: "true" }] }];
      return { sessionId: "sess-fast" };
    };
    client.setConfigOption = async (_sid, configId, value) => { onSetFast(configId, value); };
    return client;
  };
}

test("runDelegate skips the fast round-trip when the session already opens at that tier", async () => {
  let fastCalls = 0;
  await runDelegate({
    spec: "task", model: "composer-2.5", workspace: process.cwd(),
    clientFactory: opensWithFastFactory("false", () => { fastCalls++; }),
  });
  assert.equal(fastCalls, 0);
});

// The regression this exists for: one fast:true turn leaves the tier on, so every later fast:false
// turn would silently bill the higher tier if the write were skipped.
test("runDelegate sends fast=false when the session opens on the fast tier", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "composer-2.5", workspace: process.cwd(),
    clientFactory: opensWithFastFactory("true", (id, value) => seen.push([id, value])),
  });
  assert.deepEqual(seen, [["fast", false]]);
});

// The tier is per model, so the opening snapshot describes the model we left, not the one asked
// for. Skipping on it would run the wrong tier silently in both directions.
test("runDelegate sends fast after a model switch even when the opening tier matches", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "grok-4.6", fast: true, workspace: process.cwd(),
    clientFactory: opensWithFastFactory("true", (id, value) => seen.push([id, value]), "composer-2.5"),
  });
  assert.deepEqual(seen, [["fast", true]], "composer's tier says nothing about grok's");
});

test("runDelegate sends fast when the session reports no tier at all", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "composer-2.5", workspace: process.cwd(),
    clientFactory: opensWithFastFactory(undefined, (id, value) => seen.push([id, value])),
  });
  assert.deepEqual(seen, [["fast", false]], "an absent list must read as a mismatch and send");
});

test("runDelegate still sends fast=false on a resume that opens on the fast tier", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "composer-2.5", resumeSessionId: "sess-track", workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-track");
      client.loadSession = async () => {
        // sessionModels too, or openedOnModel is false and the send is forced by the model clause
        // rather than by the tier mismatch this is here to pin.
        client.sessionModels = { currentModelId: "composer-2.5", availableModels: [{ modelId: "composer-2.5" }] };
        client.configOptions = [{ id: "fast", currentValue: "true", options: [{ value: "true" }] }];
        return {};
      };
      client.setConfigOption = async (_sid, configId, value) => { seen.push([configId, value]); };
      return client;
    },
  });
  assert.deepEqual(seen, [["fast", false]]);
});

test("runDelegate sends fast=false for a routable model id, whose served model it reports", async () => {
  let fastCalls = 0;
  const out = await runDelegate({
    spec: "task",
    model: "default",
    workspace: process.cwd(),
    clientFactory: () => {
      const client = stubClient("sess-routed");
      client.setConfigOption = async () => {
        fastCalls++;
        return { configOptions: [{ id: "model", currentValue: "grok-4.6", options: [{ value: "grok-4.6" }] }] };
      };
      return client;
    },
  });
  assert.equal(fastCalls, 1);
  assert.equal(out.effectiveModel, "grok-4.6");
});

// session/new reports the model the session opened on, and Cursor carries that selection across
// sessions, so a matching id is already served. Measured against cursor-agent 2026.08.11.
function openedOnFactory(sessionId, currentModelId, availableIds, onSetModel) {
  return () => {
    const client = stubClient(sessionId);
    client.newSession = async () => {
      client.sessionModels = { currentModelId, availableModels: availableIds.map((modelId) => ({ modelId })) };
      return { sessionId };
    };
    client.setModel = async () => { onSetModel(); };
    return client;
  };
}

test("runDelegate skips set_model when the session already opened on that model", async () => {
  let setModelCalls = 0;
  await runDelegate({
    spec: "task", model: "composer-2.5", workspace: process.cwd(),
    clientFactory: openedOnFactory("sess-same", "composer-2.5", ["composer-2.5", "claude-sonnet-5"], () => { setModelCalls++; }),
  });
  assert.equal(setModelCalls, 0);
});

test("runDelegate sends set_model when the session opened on a different model", async () => {
  let setModelCalls = 0;
  await runDelegate({
    spec: "task", model: "claude-sonnet-5", workspace: process.cwd(),
    clientFactory: openedOnFactory("sess-diff", "composer-2.5", ["composer-2.5", "claude-sonnet-5"], () => { setModelCalls++; }),
  });
  assert.equal(setModelCalls, 1);
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
// effort resolves against the list the reply echoes. noOptions models a reply carrying no list.
const vals = (...v) => v.map((value) => ({ value }));
const GPT_OPTIONS = [
  { id: "model", currentValue: "gpt-5.4" },
  { id: "reasoning", options: vals("none", "low", "medium", "high", "extra-high") },
  { id: "context", options: vals("272k", "1m") },
  { id: "fast", options: vals("true", "false") },
];
const GROK_OPTIONS = [
  { id: "model", currentValue: "grok-4.5" },
  { id: "effort", options: vals("low", "medium", "high") },
  { id: "fast", options: vals("true", "false") },
];
const GROK_46_OPTIONS = [
  { id: "model", currentValue: "grok-4.6" },
  { id: "effort", options: vals("low", "medium", "high", "xhigh") },
  { id: "fast", options: vals("true", "false") },
];
// Claude declares both at once: a boolean toggle and a level.
const CLAUDE_OPTIONS = [
  { id: "model", currentValue: "claude-sonnet-5" },
  { id: "thinking", options: vals("true", "false") },
  { id: "effort", options: vals("low", "medium", "high") },
];
// Measured: claude-haiku-4-5 refuses fast and declares only thinking.
const HAIKU_OPTIONS = [
  { id: "model", currentValue: "claude-haiku-4-5" },
  { id: "thinking", options: vals("true", "false") },
];
const COMPOSER_OPTIONS = [
  { id: "model", currentValue: "composer-2.5" },
  { id: "fast", options: vals("true", "false") },
];

function configFactory({ onSet, onPrompt, refuse = [], invalid = [], options = GPT_OPTIONS, noOptions = false, opensWith }) {
  return () => {
    const client = stubClient("sess-cfg");
    if (opensWith) {
      client.newSession = async () => {
        client.sessionModels = { currentModelId: "composer-2.5", availableModels: [{ modelId: "composer-2.5" }] };
        client.configOptions = opensWith;
        return { sessionId: "sess-cfg" };
      };
    }
    client.setConfigOption = async (_sid, configId, value) => {
      if (refuse.includes(configId)) throw rpcError(-32602, `Invalid params: Unknown model config option: ${configId}`);
      if (invalid.includes(configId)) throw rpcError(-32602, `Invalid params: Invalid value for ${configId}: ${value}`);
      onSet?.(configId, value);
      return noOptions ? undefined : { configOptions: options };
    };
    client.prompt = async () => {
      onPrompt?.();
      return { stopReason: "end_turn" };
    };
    return client;
  };
}

test("runDelegate sends effort and context when the caller names them", async () => {
  const seen = [];
  const out = await runDelegate({
    spec: "task", model: "gpt-5.4", effort: "high", context: "1m",
    workspace: process.cwd(), clientFactory: configFactory({ onSet: (id, v) => seen.push([id, v]) }),
  });
  assert.deepEqual(seen, [["fast", false], ["reasoning", "high"], ["context", "1m"]]);
  assert.deepEqual(configWarnings(out), []);
});

test("runDelegate sends no config option at all when the caller omits them", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "composer-2.5", workspace: process.cwd(),
    clientFactory: configFactory({
      onSet: (id) => seen.push(id),
      opensWith: [{ id: "fast", currentValue: "false", options: [{ value: "false" }, { value: "true" }] }],
    }),
  });
  assert.deepEqual(seen, []);
});

test("runDelegate sends effort under the id the model declares", async () => {
  const seen = [];
  const out = await runDelegate({
    spec: "task", model: "grok-4.5", effort: "high", workspace: process.cwd(),
    clientFactory: configFactory({ options: GROK_OPTIONS, onSet: (id, v) => seen.push([id, v]) }),
  });
  assert.deepEqual(seen, [["fast", false], ["effort", "high"]]);
  assert.deepEqual(configWarnings(out), []);
});

test("runDelegate accepts grok xhigh exactly under the advertised effort id", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "grok-4.6", effort: "xhigh", workspace: process.cwd(),
    clientFactory: configFactory({ options: GROK_46_OPTIONS, onSet: (id, v) => seen.push([id, v]) }),
  });
  assert.deepEqual(seen, [["fast", false], ["effort", "xhigh"]]);
});

test("runDelegate rejects extra-high for grok before prompting and names exact accepted values", async () => {
  const seen = [];
  let prompts = 0;
  await assert.rejects(
    runDelegate({
      spec: "task", model: "grok-4.6", effort: "extra-high", workspace: process.cwd(),
      clientFactory: configFactory({
        options: GROK_46_OPTIONS,
        onSet: (id, v) => seen.push([id, v]),
        onPrompt: () => { prompts++; },
      }),
    }),
    (err) => {
      assert.equal(err.reason, "invalid-effort");
      assert.match(err.message, /Invalid effort "extra-high" for "grok-4\.6"/);
      assert.match(err.message, /Accepted: \["low","medium","high","xhigh"\]/);
      assert.match(err.message, /Resume with resumeSessionId sess-cfg/);
      return true;
    }
  );
  assert.deepEqual(seen, [["fast", false]], "the rejected value must not reach ACP");
  assert.equal(prompts, 0);
});

test("runDelegate keeps gpt extra-high distinct from xhigh", async () => {
  const accepted = [];
  await runDelegate({
    spec: "task", model: "gpt-5.4", effort: "extra-high", workspace: process.cwd(),
    clientFactory: configFactory({ onSet: (id, v) => accepted.push([id, v]) }),
  });
  assert.deepEqual(accepted, [["fast", false], ["reasoning", "extra-high"]]);

  let prompts = 0;
  await assert.rejects(
    runDelegate({
      spec: "task", model: "gpt-5.4", effort: "xhigh", workspace: process.cwd(),
      clientFactory: configFactory({ onPrompt: () => { prompts++; } }),
    }),
    (err) => {
      assert.equal(err.reason, "invalid-effort");
      assert.match(err.message, /Accepted: \["none","low","medium","high","extra-high"\]/);
      return true;
    }
  );
  assert.equal(prompts, 0);
});

test("runDelegate accepts future effort tokens when the model advertises them", async () => {
  const options = [
    { id: "model", currentValue: "future-model" },
    { id: "thought_level", options: vals("max", "ultra") },
    { id: "fast", options: vals("true", "false") },
  ];
  for (const effort of ["max", "ultra"]) {
    const seen = [];
    await runDelegate({
      spec: "task", model: "future-model", effort, workspace: process.cwd(),
      clientFactory: configFactory({ options, onSet: (id, v) => seen.push([id, v]) }),
    });
    assert.deepEqual(seen, [["fast", false], ["thought_level", effort]]);
  }
});

test("runDelegate does not case-fold effort values", async () => {
  await assert.rejects(
    runDelegate({
      spec: "task", model: "gpt-5.4", effort: "EXTRA-HIGH", workspace: process.cwd(),
      clientFactory: configFactory({}),
    }),
    (err) => err.reason === "invalid-effort" && /Invalid effort "EXTRA-HIGH"/.test(err.message)
  );
});

test("runDelegate prefers effort over a boolean thinking toggle when a model declares both", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "claude-sonnet-5", effort: "high", workspace: process.cwd(),
    clientFactory: configFactory({ options: CLAUDE_OPTIONS, onSet: (id, v) => seen.push([id, v]) }),
  });
  assert.deepEqual(seen, [["fast", false], ["effort", "high"]]);
});

// claude-haiku-4-5 refuses fast, so no reply carries its list; re-asserting the model recovers it.
test("runDelegate recovers the option list by re-asserting the model when fast is refused", async () => {
  const seen = [];
  const out = await runDelegate({
    spec: "task", model: "claude-sonnet-5", effort: "high", workspace: process.cwd(),
    clientFactory: configFactory({
      options: CLAUDE_OPTIONS, refuse: ["fast"], onSet: (id, v) => seen.push([id, v]),
    }),
  });
  assert.deepEqual(seen, [["model", "claude-sonnet-5"], ["effort", "high"]]);
  assert.deepEqual(configWarnings(out), []);
});

// claude-haiku-4-5 declares only the boolean thinking. Exact true/false still work, while a
// level is rejected locally instead of being guessed or ignored.
test("runDelegate rejects a level for a boolean-only model before prompting", async () => {
  const seen = [];
  let prompts = 0;
  await assert.rejects(
    runDelegate({
      spec: "task", model: "claude-haiku-4-5", effort: "high", workspace: process.cwd(),
      clientFactory: configFactory({
        options: HAIKU_OPTIONS,
        refuse: ["fast"],
        onSet: (id, v) => seen.push([id, v]),
        onPrompt: () => { prompts++; },
      }),
    }),
    (err) => {
      assert.equal(err.reason, "invalid-effort");
      assert.match(err.message, /Accepted: \["true","false"\]/);
      return true;
    }
  );
  assert.deepEqual(seen, [["model", "claude-haiku-4-5"]]);
  assert.equal(prompts, 0);
});

test("runDelegate sends exact boolean effort to a boolean-only thinking option", async () => {
  const seen = [];
  await runDelegate({
    spec: "task", model: "claude-haiku-4-5", effort: "true", workspace: process.cwd(),
    clientFactory: configFactory({
      options: HAIKU_OPTIONS, refuse: ["fast"], onSet: (id, v) => seen.push([id, v]),
    }),
  });
  assert.deepEqual(seen, [["model", "claude-haiku-4-5"], ["thinking", "true"]]);
});

test("runDelegate rejects explicit effort for Composer and names no accepted value", async () => {
  let prompts = 0;
  await assert.rejects(
    runDelegate({
      spec: "task", model: "composer-2.5", effort: "xhigh", workspace: process.cwd(),
      clientFactory: configFactory({ options: COMPOSER_OPTIONS, onPrompt: () => { prompts++; } }),
    }),
    (err) => {
      assert.equal(err.reason, "invalid-effort");
      assert.match(err.message, /Model "composer-2.5" does not advertise configurable effort/);
      assert.match(err.message, /Accepted: none/);
      assert.match(err.message, /Omit effort; do not send "none"/);
      assert.match(err.message, /Resume with resumeSessionId sess-cfg/);
      return true;
    }
  );
  assert.equal(prompts, 0);
});

// Last resort: fast refused and re-asserting the model carried no option list either. That is a
// capability-read failure, not evidence that the caller's exact token is invalid.
test("runDelegate fails separately when the effort option list cannot be recovered", async () => {
  let prompts = 0;
  await assert.rejects(
    runDelegate({
      spec: "task", model: "claude-haiku-4-5", fast: true, effort: "high", workspace: process.cwd(),
      clientFactory: configFactory({
        noOptions: true, refuse: ["fast"], onPrompt: () => { prompts++; },
      }),
    }),
    (err) => {
      assert.equal(err.reason, "effort-options-unavailable");
      assert.match(err.message, /did not report a usable effort option list/);
      assert.match(err.message, /Resume with resumeSessionId sess-cfg/);
      return true;
    }
  );
  assert.equal(prompts, 0);
});

test("runDelegate treats an empty reported option list as unavailable, not unsupported", async () => {
  let prompts = 0;
  await assert.rejects(
    runDelegate({
      spec: "task", model: "grok-4.6", effort: "xhigh", workspace: process.cwd(),
      clientFactory: configFactory({ options: [], onPrompt: () => { prompts++; } }),
    }),
    (err) => {
      assert.equal(err.reason, "effort-options-unavailable");
      assert.doesNotMatch(err.message, /Accepted: none/);
      return true;
    }
  );
  assert.equal(prompts, 0);
});

test("runDelegate fails separately when a model rejects the effort option it advertised", async () => {
  let prompts = 0;
  await assert.rejects(
    runDelegate({
      spec: "task", model: "grok-4.5", effort: "high", workspace: process.cwd(),
      clientFactory: configFactory({
        options: GROK_OPTIONS, refuse: ["effort"], onPrompt: () => { prompts++; },
      }),
    }),
    (err) => {
      assert.equal(err.reason, "effort-options-unavailable");
      assert.match(err.message, /advertised option "effort" but rejected it/);
      return true;
    }
  );
  assert.equal(prompts, 0);
});

test("runDelegate does not require an option list when effort is omitted", async () => {
  let prompts = 0;
  await runDelegate({
    spec: "task", model: "composer-2.5", workspace: process.cwd(),
    clientFactory: configFactory({ noOptions: true, onPrompt: () => { prompts++; } }),
  });
  assert.equal(prompts, 1);
});

test("runDelegate preserves an agent rejection for an advertised exact effort", async () => {
  await assert.rejects(
    runDelegate({
      spec: "task", model: "gpt-5.4", effort: "high",
      workspace: process.cwd(), clientFactory: configFactory({ invalid: ["reasoning"] }),
    }),
    (err) => {
      assert.match(err.message, /Invalid value for reasoning: high/);
      assert.equal(err.reason, "agent-error");
      return true;
    }
  );
});

test("runDelegate leaves an existing reason alone and tags nothing without an rpc code", async () => {
  const factory = () => {
    const client = stubClient();
    client.start = async () => { throw new Error("spawn failed"); };
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

// The id is assigned at session/new, before the model and config calls that raise this — so the
// session is live and resumable, and the hint used to be reserved for stalls and exits.
test("a failure after the session exists still names the id to resume", async () => {
  await assert.rejects(
    runDelegate({
      spec: "task", model: "no-such-model", workspace: process.cwd(),
      clientFactory: modelListFactory([{ modelId: "composer-2.5" }]),
    }),
    (err) => {
      assert.equal(err.reason, "unknown-model");
      assert.match(err.message, /Resume with resumeSessionId /);
      return true;
    }
  );
});

test("runDelegate surfaces the agent-assigned title as progress, not in the result", async () => {
  const progress = [];
  const factory = () => {
    const client = stubClient("sess-titled");
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "session_info_update", title: "File Creator" } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    };
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
    const client = stubClient("sess-fresh");
    client.loadSession = async () => { throw rpcError(-32602, "Invalid params: Session old-id not found"); };
    return client;
  };
  const out = await runDelegate({
    spec: "task", resumeSessionId: "old-id", workspace: process.cwd(), clientFactory: factory,
  });
  assert.equal(out.sessionId, "sess-fresh");
  assert.equal(out.resumed, undefined);
  assert.ok(out.protocolWarnings.some((w) => /resuming old-id failed.*Session old-id not found/.test(w)));
});

// Falling back on *any* load failure ran the task in a fresh session, without the context the
// caller asked for, and reported it as a warning on a successful result.
test("runDelegate fails rather than starting fresh when a resume dies for another reason", async () => {
  let newSessions = 0;
  const factory = () => {
    const client = stubClient("sess-fresh");
    const origNew = client.newSession.bind(client);
    client.newSession = async (cwd) => { newSessions++; return origNew(cwd); };
    // A restore failure: -32603 carrying both "session" and a sentinel word, which a classifier
    // matching wording without the code would read as missing.
    client.loadSession = async () => {
      throw rpcError(-32603, 'Failed to load session "old-id": storage backend not found');
    };
    return client;
  };
  await assert.rejects(
    () => runDelegate({
      spec: "task", resumeSessionId: "old-id", workspace: process.cwd(), clientFactory: factory,
    }),
    (err) => {
      assert.equal(err.reason, "resume-failed");
      assert.match(err.message, /storage backend not found/);
      return true;
    }
  );
  assert.equal(newSessions, 0, "a failed resume must not silently spend a fresh session");
});

test("runDelegate captures session/update:plan with latest update winning", async () => {
  const out = await runDelegate({ spec: "draft a plan", mode: "plan", workspace: process.cwd(), clientFactory: fakeFactory });
  assert.equal(out.stopReason, undefined);
  // In plan/ask result is the agent's own message verbatim — no bridge-side promotion of the
  // filed plan into it. The plan itself stays out: it lives in the agent's session, and entries
  // here would only restate result in the orchestrator's context.
  assert.equal(out.result, "plan ready");
  assert.equal(out.resultSource, undefined);
  assert.equal(out.plan, undefined, "the plan is dropped in plan/ask; result is the plan");
  assert.equal(out.filesReportedByEditTools, undefined);
});

function planDetailFactory({ message, overview, plan, trailingTool = false }) {
  return ({ onCreatePlan }) => {
    const client = stubClient("sess-plandetail");
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
    return client;
  };
}

// In plan/ask result is the agent's own message verbatim and the whole plan is dropped (it lives
// in the agent's session, which is what a resume-to-implement reads). The rule is the mode alone
// — no bridge-side promotion — so these three replies, which a former length heuristic told
// apart, must now all come back untouched.
for (const [shape, message] of [
  ["a full plan message", "Here is the plan in full. " + "Ship the change step by step with rationale. ".repeat(5)],
  ["a terse message", "plan ready"],
  ["a clarifying question", "Should the config format be TOML or JSON?"],
]) {
  test(`runDelegate returns ${shape} verbatim and drops the plan`, async () => {
    const out = await runDelegate({
      spec: "plan it", mode: "plan", workspace: process.cwd(),
      clientFactory: planDetailFactory({ message, overview: "ov", plan: "# Plan\n\n1. The filed plan document." }),
    });
    assert.equal(out.result, message, "result is the agent's own message");
    assert.equal(out.resultSource, undefined);
    assert.equal(out.plan, undefined, "plan is dropped in plan/ask; result carries it");
  });
}

test("runDelegate falls back to the pre-tool preamble when a trailing tool leaves no final message", async () => {
  const plan = "# Plan\n\n1. A detailed multi-step plan filed before the agent ran a tool.";
  const out = await runDelegate({
    spec: "plan it", mode: "plan", workspace: process.cwd(),
    clientFactory: planDetailFactory({ message: "Reviewing the code.", overview: "ov", plan, trailingTool: true }),
  });
  // No promotion: with no final message, the ordinary pre-tool-fallback applies — result is the
  // discarded preamble, flagged as such — and the filed plan stays out of result and out of plan.
  assert.equal(out.result, "Reviewing the code.");
  assert.equal(out.resultSource, "pre-tool-fallback");
  assert.equal(out.plan, undefined);
  assert.ok(out.protocolWarnings.some((w) => /never spoke again/.test(w)));
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
  const client = stubClient("sess-replay");
  client.prompt = async () => {
    for (const update of updates) client.emit("update", { update });
    return { stopReason: "end_turn" };
  };
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

test("a multi-line tool title is reported as one line", async () => {
  // A terminal tool's title is the command the agent sent, and it sends a multi-line script
  // verbatim. Both readers of this take one line: the progress notification, and the "last tool
  // call" line a stall error carries.
  const title = ["npm run build", "  --workspace=api", "", "  --silent"].join("\n");
  const progress = await collectProgress([
    { sessionUpdate: "tool_call", toolCallId: "t1", title, kind: "execute", status: "pending" },
  ]);
  const line = progress.find((m) => m.startsWith("running: "));
  assert.ok(line, "the tool call must be reported");
  assert.ok(!/[\r\n]/.test(line), `the reported command must be one line, got ${JSON.stringify(line)}`);
  assert.equal(line, "running: npm run build --workspace=api --silent");
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
  return ({ mode, onCreatePlan }) => {
    const client = fakeFactory({ mode, onCreatePlan });
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
  return ({ mode, onCreatePlan }) => {
    const client = fakeFactory({ mode, onCreatePlan });
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
  return ({ mode, onCreatePlan }) => {
    const client = fakeFactory({ mode, onCreatePlan });
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
  assert.ok(out.protocolWarnings.some((w) => /contextFile skipped: 1 not found under .* — no-such-file-here\.txt/.test(w)));
});

// One warning for the whole batch, not one each: a wrong workspace misses every attachment at
// once, and a line apiece would repeat the same root for a single root cause.
test("runDelegate groups every missing contextFile into one warning", async () => {
  const track = {};
  const missing = Array.from({ length: 20 }, (_, i) => `missing-${String(i + 1).padStart(2, "0")}.js`);
  const out = await runDelegate({
    spec: "review these",
    mode: "agent",
    workspace: process.cwd(),
    contextFiles: ["package.json", ...missing],
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.blocks.length, 2, "only the real file is linked");
  assert.equal(out.protocolWarnings.length, 1, "20 missing files produce one warning, not 20");
  const [warning] = out.protocolWarnings;
  assert.match(warning, /^contextFiles skipped: 20 not found under /);
  for (const name of missing) assert.ok(warning.includes(name), `${name} is named`);
  // The workspace root is the diagnostic — stated once, not once per file.
  assert.equal(warning.split(process.cwd()).length - 1, 1, "the root appears exactly once");
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
  return ({ mode, onCreatePlan }) => {
    const client = fakeFactory({ mode, onCreatePlan });
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

test("runDelegate sends a brief that names a path as written", async () => {
  const track = {};
  await runDelegate({
    spec: "fix the bug in missing/brief.md",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: promptTextFactory(track),
  });
  assert.equal(track.promptText, "fix the bug in missing/brief.md");
});

// The contract spec-as-path used to break: a brief is the prompt, whatever it looks like. This
// pins the case the old path detection got wrong — a spec that is itself an existing file name.
test("runDelegate sends a spec literally even when a file of that name exists", async () => {
  const inlineSpec = "brief.md";
  const specPath = path.join(process.cwd(), inlineSpec);
  writeFileSync(specPath, "file contents must not be used\n");
  const track = {};
  try {
    await runDelegate({
      spec: inlineSpec,
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: promptTextFactory(track),
    });
    assert.equal(track.promptText, inlineSpec);
  } finally {
    try { unlinkSync(specPath); } catch {}
  }
});

function exitDuringPromptFactory() {
  return ({ mode, onCreatePlan }) => {
    const client = fakeFactory({ mode, onCreatePlan });
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

test("runDelegate returns output above the former 10MB cap verbatim", async () => {
  const out = await runDelegate({
    spec: "big task",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: () => oversizedFactory(),
  });
  // 12 one-megabyte chunks: over the former ceiling, delivered whole — model output
  // is bounded by the model's own token limit, so there is nothing left to guard against.
  assert.equal(out.result.length, 12 * 1024 * 1024);
  assert.ok(!out.result.includes("[output truncated"));
});

function failingPromptFactory() {
  return ({ mode, onCreatePlan }) => {
    const client = fakeFactory({ mode, onCreatePlan });
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

// The same variable is read twice — recording in jsonrpc.js, attachment here. A non-numeric
// value must read as on at the default depth in both places, not on in one and off in the other.
test("runDelegate appends the transcript when CURSOR_DELEGATE_TRANSCRIPT is a non-numeric string", async () => {
  process.env.CURSOR_DELEGATE_TRANSCRIPT = "true";
  try {
    await assert.rejects(
      () => runDelegate({
        spec: "do the thing",
        mode: "agent",
        workspace: process.cwd(),
        clientFactory: failingPromptFactory(),
      }),
      (err) => {
        assert.match(err.message, /--- recent ACP transcript \(last 2000 frames\) ---/);
        return true;
      }
    );
  } finally {
    delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
  }
});

function scriptedFactory({ planEntries, stopReason = "end_turn", message = "plan ready" }) {
  return () => {
    const client = stubClient("sess-scripted");
    client.prompt = async () => {
      if (planEntries) client.emit("update", { update: { sessionUpdate: "plan", entries: planEntries } });
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: message } } });
      return { stopReason };
    };
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
  // The plan itself is dropped in plan mode, but sanitizing still runs: a malformed frame is the
  // agent misbehaving, and the caller needs to hear about it whatever mode it asked for.
  assert.equal(out.plan, undefined);
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

// agent mode, so this also covers well-formed entries surviving sanitization intact — the only
// mode that still returns them.
test("runDelegate omits protocolWarnings when frames are well-formed", async () => {
  const out = await runDelegate({
    spec: "do it",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: scriptedFactory({ planEntries: [{ content: "ok", priority: "low", status: "completed" }] }),
  });
  assert.equal(out.protocolWarnings, undefined);
  assert.deepEqual(out.plan.entries, [{ content: "ok", priority: "low", status: "completed" }]);
});

function abortablePromptFactory({ onAbortReady, track }) {
  return () => {
    const client = stubClient("sess-abort");
    client.cancel = async () => {};
    client.child = { pid: null, exitCode: null, signalCode: null, kill() {} };
    client.prompt = () => new Promise((resolve) => { onAbortReady?.(resolve); });
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

// Frames replayed from a raw multi-step todo-stream capture (2026-07-22): one merge:false
// full list, then merge:true deltas carrying only the changed entries.
function todoFactory(frames) {
  return ({ onTodos }) => {
    const client = stubClient("sess-todo");
    client.prompt = async () => {
      for (const f of frames) onTodos(f);
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } });
      return { stopReason: "end_turn" };
    };
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
    const client = stubClient("sess-hb");
    client.prompt = () => {
      onTodos({ merge: false, todos: [
        { id: "1", content: "Set up fixtures", status: "completed" },
        { id: "2", content: "Run integration tests", status: "in_progress" },
      ] });
      return new Promise(() => {});
    };
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
    const client = stubClient("sess-forensics");
    client.loadSession = async () => {
      if (loadFails) throw rpcError(-32602, "Invalid params: Session stale-id not found");
    };
    client.cancel = async () => {};
    client.prompt = () => {
      if (title) client.emit("update", { update: { sessionUpdate: "session_info_update", title } });
      for (const f of frames) onTodos(f);
      emit?.(client);
      return new Promise(() => {});
    };
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
    const client = stubClient("sess-models");
    client.newSession = async () => {
      if (availableModels !== undefined) client.sessionModels = { availableModels };
      return { sessionId: "sess-models" };
    };
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } });
      return { stopReason: "end_turn" };
    };
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

// An edit tool_call carries title "Edit File" and no locations, so the file it touched is only
// knowable from the diff frame that follows — which still feeds filesReportedByEditTools, in any
// mode. (The mode is not an enforced boundary; the diff is the source of truth, so it is reported
// the same whether the agent was asked to plan or to implement.)
test("runDelegate reports a plan-mode edit via filesReportedByEditTools from its diff frame", async () => {
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
  assert.deepEqual(out.filesReportedByEditTools, ["docs/plan.md"]);
});

// session/load replays the previous turn: measured 23 frames, incl. tool_call with
// synthetic "replay-0-N" ids and tool_call_update carrying real diff blocks.
function loadReplayFactory() {
  const client = stubClient("sess-new");
  const replay = () => {
    client.emit("update", { update: { sessionUpdate: "user_message_chunk", content: { text: "earlier request" } } });
    client.emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "replay-0-2", title: "Edit File", status: "pending" } });
    client.emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "replay-0-2", status: "completed",
      content: [{ type: "diff", path: "from-a-previous-turn.txt" }] } });
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "stale result text" } } });
  };
  client.loadSession = async () => { replay(); return {}; };
  client.prompt = async () => {
    client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "fresh answer" } } });
    return { stopReason: "end_turn" };
  };
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

// The same rule as above, over the real fake-acp subprocess rather than a hand stub: the replay
// arrives through an actual ACP transport, so this also covers the client's own framing.
test("a diff replayed during session/load stays out of the resumed turn's reported files", async () => {
  const replayTouchedFactory = () => ({ mode, onCreatePlan }) => {
    const client = fakeFactory({ mode, onCreatePlan });
    const origLoad = client.loadSession.bind(client);
    client.loadSession = async (sessionId, cwd) => {
      const res = await origLoad(sessionId, cwd);
      client.emit("update", {
        update: {
          sessionUpdate: "tool_call_update",
          content: [{ type: "diff", path: "stale-replay.txt" }],
        },
      });
      return res;
    };
    return client;
  };
  const out = await runDelegate({
    spec: "continue",
    mode: "agent",
    resumeSessionId: "sess-resumed",
    workspace: process.cwd(),
    clientFactory: replayTouchedFactory(),
  });
  assert.equal(out.resumed, true);
  assert.deepEqual(out.filesReportedByEditTools, ["hello.txt"]);
  assert.ok(!out.filesReportedByEditTools.includes("stale-replay.txt"));
});

test("a non-positive hard cap falls back to the default instead of firing instantly", async () => {
  // Number("") is 0, so a blank env var used to arm a zero-length deadline that failed every
  // call before the agent could answer. Only the idle guard gives 0 a meaning of its own.
  const prev = process.env.CURSOR_DELEGATE_HARD_CAP_MS;
  process.env.CURSOR_DELEGATE_HARD_CAP_MS = "0";
  try {
    const out = await runDelegate({ workspace: process.cwd(), spec: "hi", clientFactory: thinkingFactory(), heartbeatMs: 0 });
    assert.equal(out.result, "done");
  } finally {
    if (prev === undefined) delete process.env.CURSOR_DELEGATE_HARD_CAP_MS;
    else process.env.CURSOR_DELEGATE_HARD_CAP_MS = prev;
  }
});

test("frames arriving after the prompt settles do not mutate the finished turn", async () => {
  // A late tool_call_update carrying a diff used to be folded into the result while it was
  // still being assembled across awaits.
  let emitLate;
  const clientFactory = () => {
    const client = stubClient("sess-late");
    client.prompt = async () => {
      client.emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { text: "answer" } } });
      emitLate = () => client.emit("update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "late",
          status: "completed",
          content: [{ type: "diff", path: "ghost.js" }],
        },
      });
      return { stopReason: "end_turn" };
    };
    return client;
  };
  const out = await runDelegate({
    spec: "task",
    workspace: process.cwd(),
    clientFactory,
    heartbeatMs: 0,
    onProgress: () => emitLate?.(),
  });
  assert.equal(out.result, "answer");
  assert.equal(out.filesReportedByEditTools, undefined, "a frame after the turn belongs to no turn");
});

test("a delegation without a workspace is refused before anything is spawned", async () => {
  // The server's own cwd under npx or a plugin launch is a cache directory or the user's home,
  // so a defaulted workspace put an auto-approved agent to work on a tree nobody asked about
  // while every layer reported success.
  let spawned = false;
  const clientFactory = () => { spawned = true; return {}; };
  for (const workspace of [undefined, "", "   "]) {
    await assert.rejects(
      () => runDelegate({ spec: "task", workspace, clientFactory }),
      (err) => err.reason === "invalid-workspace" && /workspace is required/.test(err.message)
    );
  }
  assert.equal(spawned, false, "the workspace check must run before the agent is spawned");
});
