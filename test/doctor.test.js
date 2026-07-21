import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../src/doctor.js";
import { VERSION } from "../src/version.js";

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

test("runDoctor derives supportsElicitation from injected getClientInfo", async () => {
  const withElicit = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({
      capabilities: { elicitation: {} },
      version: { name: "test-client", version: "1.0" },
    }),
  });
  assert.equal(withElicit.client.supportsElicitation, true);
  assert.equal(withElicit.client.name, "test-client");
  assert.equal(withElicit.client.version, "1.0");

  const withoutElicit = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(withoutElicit.client.supportsElicitation, false);
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
    modes: [],
  });
  assert.ok(calls.includes("start"));
  assert.ok(calls.includes("initialize"));
  assert.ok(calls.includes("newSession"));
  assert.ok(calls.includes("stop"));
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
  } finally {
    if (prev === undefined) delete process.env.ACP_LOG_SIZE;
    else process.env.ACP_LOG_SIZE = prev;
  }
});

test("runDoctor reports portable runtime diagnostics", async () => {
  const out = await runDoctor({
    getClientInfo: () => ({ capabilities: { elicitation: {} }, version: { name: "host", version: "1" } }),
    spawnSpec: stubSpawnSpec(),
  });

  assert.equal(out.runtime.transport, "stdio");
  assert.equal(out.runtime.node, process.versions.node);
  assert.equal(out.runtime.platform, process.platform);
  assert.equal(out.client.supportsElicitation, true);
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
