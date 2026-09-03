import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runDoctor as rawRunDoctor } from "../src/doctor.js";
import { doctorOutputShape, doctorAgentShape, doctorHandshakeShape } from "../src/server.js";
import { VERSION } from "../src/version.js";

// Every result this suite produces is parsed against a strict copy of doctorOutputShape, for
// the reason delegate.test.js does the same: the shape is not declared to hosts, so a field
// added to the result but forgotten there would drift undocumented and no test would fail.
// agent and handshake are each made strict, because .strict() does not look inside a nested
// object and both levels have drifted — agent in 1.14.0, handshake with currentModelOptions.
const strictOutput = z.object({
  ...doctorOutputShape,
  agent: z.object({
    ...doctorAgentShape,
    handshake: z.object(doctorHandshakeShape).strict().optional(),
  }).strict(),
}).strict();
const runDoctor = async (opts) => {
  const out = await rawRunDoctor(opts);
  strictOutput.parse(out);
  return out;
};

const stubPath = fileURLToPath(new URL("./fixtures/agent-stub.js", import.meta.url));

function stubSpawnSpec() {
  return {
    command: stubPath,
    args: ["acp"],
    options: { shell: false },
  };
}

test("runDoctor reports agent.found, command, and version for a present launcher", async () => {
  const out = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.found, true);
  assert.match(out.agent.command, /agent-stub\.js/);
  assert.equal(out.agent.version, "fake-agent 2.0.0");
  assert.equal(out.agent.handshake, undefined);
});

test("runDoctor reports agent.version null when the command fails", async () => {
  const out = await runDoctor({
    spawnSpec: { command: "nonexistent-agent-xyz-12345", args: ["acp"], options: {} },
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.found, false);
  assert.equal(out.agent.version, null);
});

test("runDoctor times out a launcher that never answers --version", async () => {
  const hangPath = fileURLToPath(new URL("./fixtures/version-hang-stub.js", import.meta.url));
  const started = Date.now();
  const out = await runDoctor({
    spawnSpec: { command: hangPath, args: ["acp"], options: { shell: false } },
    versionTimeoutMs: 250,
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.ok(Date.now() - started < 8000, "the probe must time out, not hang");
  // The launcher spawned, so it is found; it just never answered.
  assert.equal(out.agent.found, true);
  assert.equal(out.agent.version, null);
  assert.match(out.agent.error, /version probe timed out after 250ms/);
});

test("runDoctor reports agent.error when --version exits non-zero", async () => {
  const failPath = fileURLToPath(new URL("./fixtures/version-exit-one.js", import.meta.url));
  const out = await runDoctor({
    spawnSpec: { command: failPath, args: ["acp"], options: { shell: false } },
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.found, true);
  assert.equal(out.agent.version, null);
  assert.match(out.agent.error, /version probe exited 1/);
});

test("runDoctor probes a .mjs launcher with node", async () => {
  const mjsPath = fileURLToPath(new URL("./fixtures/agent-stub.mjs", import.meta.url));
  const out = await runDoctor({
    spawnSpec: { command: mjsPath, args: ["acp"], options: { shell: false } },
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.found, true);
  assert.equal(out.agent.version, "fake-agent-mjs 2.0.0");
  assert.equal(out.agent.error, undefined);
});

// The probe opens stderr as a pipe. With no reader on it the launcher cannot drain its own
// write buffer and never exits, so a merely noisy launcher gets diagnosed as one that spawned
// and never answered — the same output as a wedged agent, for a healthy one.
test("runDoctor reads the version of a launcher that floods stderr", async () => {
  const floodPath = fileURLToPath(new URL("./fixtures/version-stderr-flood.js", import.meta.url));
  const started = Date.now();
  const out = await runDoctor({
    spawnSpec: { command: floodPath, args: ["acp"], options: { shell: false } },
    versionTimeoutMs: 4000,
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.ok(Date.now() - started < 4000, "the probe must not reach its timeout");
  assert.equal(out.agent.found, true);
  assert.equal(out.agent.version, "fake-agent 3.0.0");
  assert.equal(out.agent.error, undefined);
});

test("runDoctor reports raw client capabilities and identity from injected getClientInfo", async () => {
  const withElicit = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({
      capabilities: { elicitation: {} },
      version: { name: "test-client", version: "1.0" },
    }),
  });
  assert.deepEqual(withElicit.client.capabilities, { elicitation: {} });
  assert.equal(withElicit.client.name, "test-client");
  assert.equal(withElicit.client.version, "1.0");

  const withoutElicit = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.deepEqual(withoutElicit.client.capabilities, {});
});

test("runDoctor deep:false does not run handshake", async () => {
  let handshakeCalls = 0;
  const clientFactory = () => {
    handshakeCalls++;
    return {
      start: async () => {},
      initialize: async () => {},
      newSession: async () => ({ sessionId: "s" }),
      stop: () => {},
    };
  };
  const out = await runDoctor({
    deep: false,
    spawnSpec: stubSpawnSpec(),
    clientFactory,
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(handshakeCalls, 0);
  assert.equal(out.agent.handshake, undefined);
});

test("runDoctor deep:true runs handshake via clientFactory", async () => {
  const calls = [];
  const clientFactory = ({ spawnSpec }) => {
    calls.push("factory");
    return {
      start: async () => { calls.push("start"); },
      initialize: async () => { calls.push("initialize"); },
      newSession: async (cwd) => { calls.push("newSession", cwd); return { sessionId: "s" }; },
      stop: () => { calls.push("stop"); },
    };
  };
  const out = await runDoctor({
    deep: true,
    spawnSpec: stubSpawnSpec(),
    clientFactory,
    workspace: process.cwd(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.deepEqual(out.agent.handshake, {
    ok: true,
    protocolVersion: null,
    agentCapabilities: {},
    models: [],
    currentModel: null,
    currentModelOptions: [],
    modes: [],
  });
  assert.ok(calls.includes("start"));
  assert.ok(calls.includes("initialize"));
  assert.ok(calls.includes("newSession"));
  assert.ok(calls.includes("stop"));
});

// The test above leaves configOptions unset, so it only ever proves the empty case. This drives
// the filter and map that build the field: model and mode are reported as their own handshake
// keys, so they are dropped here, and each remaining option keeps only its string values.
test("runDoctor deep:true reports currentModelOptions without the model and mode keys", async () => {
  const clientFactory = () => ({
    start: async () => {},
    initialize: async () => {},
    newSession: async () => ({ sessionId: "s" }),
    stop: () => {},
    configOptions: [
      { id: "model", options: [{ value: "composer-2.5" }] },
      { id: "mode", options: [{ value: "agent" }] },
      { id: "fast", options: [{ value: "false" }, { value: "true" }] },
      { id: "thinking", options: [{ value: "high" }, { value: 7 }] },
    ],
  });
  const out = await runDoctor({
    deep: true,
    spawnSpec: stubSpawnSpec(),
    clientFactory,
    workspace: process.cwd(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.deepEqual(out.agent.handshake.currentModelOptions, [
    { id: "fast", values: ["false", "true"] },
    // 7 is dropped: a non-string value is not something a caller can pass back.
    { id: "thinking", values: ["high"] },
  ]);
});

test("runDoctor deep:true reports handshake error without throwing", async () => {
  const clientFactory = () => ({
    start: async () => { throw new Error("not logged in"); },
    initialize: async () => {},
    newSession: async () => ({}),
    stop: () => {},
  });
  const out = await runDoctor({
    deep: true,
    spawnSpec: stubSpawnSpec(),
    clientFactory,
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.handshake.ok, false);
  assert.match(out.agent.handshake.error, /not logged in/);
});

test("runDoctor deep:true times out a hanging handshake and stops the client", async () => {
  let stopCalls = 0;
  const clientFactory = () => ({
    start: () => new Promise(() => {}), // hangs forever
    initialize: async () => {},
    newSession: async () => ({ sessionId: "s" }),
    stop: () => { stopCalls++; },
  });
  const out = await runDoctor({
    deep: true,
    spawnSpec: stubSpawnSpec(),
    clientFactory,
    handshakeTimeoutMs: 50,
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.handshake.ok, false);
  assert.match(out.agent.handshake.error, /timed out after 50ms/);
  assert.ok(stopCalls >= 1, "expected the hanging client to be stopped");
});

test("runDoctor reports plugin version and ACP_LOG_SIZE default", async () => {
  const prev = process.env.ACP_LOG_SIZE;
  delete process.env.ACP_LOG_SIZE;
  try {
    const out = await runDoctor({
      spawnSpec: stubSpawnSpec(),
      getClientInfo: () => ({ capabilities: {}, version: {} }),
    });
    assert.equal(out.plugin.version, VERSION);
    assert.equal(out.env.ACP_LOG_SIZE, "2000");
    assert.ok("ACP_AGENT_COMMAND" in out.env);
    assert.ok("ACP_AGENT_ARGS" in out.env);
    assert.ok("CURSOR_DELEGATE_HANDSHAKE_MS" in out.env);
    assert.ok("CURSOR_DELEGATE_HARD_CAP_MS" in out.env);
    assert.ok("CURSOR_DELEGATE_IDLE_MS" in out.env);
  } finally {
    if (prev === undefined) delete process.env.ACP_LOG_SIZE;
    else process.env.ACP_LOG_SIZE = prev;
  }
});

test("runDoctor reads the plugin version fresh rather than from a load-time constant", async () => {
  // The MCP child is long-lived; a version frozen at process start goes stale after an
  // in-place upgrade. doctor must resolve it through the reader it is given, each call.
  const out = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
    readVersion: () => "9.9.9-fresh",
  });
  assert.equal(out.plugin.version, "9.9.9-fresh");
});

test("runDoctor reports portable runtime diagnostics", async () => {
  const out = await runDoctor({
    getClientInfo: () => ({ capabilities: { elicitation: {} }, version: { name: "host", version: "1" } }),
    spawnSpec: stubSpawnSpec(),
  });

  assert.equal(out.runtime.transport, "stdio");
  assert.equal(out.runtime.node, process.versions.node);
  assert.equal(out.runtime.platform, process.platform);
  assert.deepEqual(out.client.capabilities, { elicitation: {} });
});

test("runDoctor deep:true reports the negotiated capability matrix", async () => {
  const clientFactory = () => ({
    start: async () => {},
    initialize: async function () {
      this.protocolVersion = 1;
      this.agentCapabilities = { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } };
    },
    newSession: async function () {
      this.sessionModels = { currentModelId: "composer-2.5", availableModels: [{ modelId: "composer-2.5" }, { modelId: "claude-opus-4-8" }] };
      this.sessionModes = { currentModeId: "agent", availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }] };
      return { sessionId: "s" };
    },
    stop: () => {},
  });
  const out = await runDoctor({
    deep: true,
    spawnSpec: stubSpawnSpec(),
    clientFactory,
    workspace: process.cwd(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.handshake.ok, true);
  assert.equal(out.agent.handshake.protocolVersion, 1);
  assert.equal(out.agent.handshake.currentModel, "composer-2.5");
  assert.deepEqual(out.agent.handshake.models, ["composer-2.5", "claude-opus-4-8"]);
  assert.deepEqual(out.agent.handshake.modes, ["agent", "plan", "ask"]);
  assert.equal(out.agent.handshake.agentCapabilities.sessionCapabilities.list !== undefined, true);
});
