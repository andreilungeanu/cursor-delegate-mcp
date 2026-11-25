import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { probeAgentVersion, runDoctor as rawRunDoctor } from "../src/doctor.js";
import { AcpClient } from "../src/acp-client.js";
import { createChildRegistry, isChildAlive } from "../src/proc.js";
import { doctorOutputShape, doctorAgentShape, doctorSessionShape, doctorModelsShape } from "./output-shapes.js";
import { VERSION } from "../src/version.js";
import { DEFAULT_MODEL } from "../src/delegate.js";

// Every result this suite produces is parsed against a strict copy of doctorOutputShape, for
// the reason delegate.test.js does the same: the shape is not declared to hosts, so a field
// added to the result but forgotten there would drift undocumented and no test would fail.
// Each nested object is made strict too, because .strict() does not look inside one.
const strictOutput = z.object({
  ...doctorOutputShape,
  agent: z.object(doctorAgentShape).strict(),
  session: z.object(doctorSessionShape).strict().optional(),
  models: z.object(doctorModelsShape).strict().optional(),
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
  assert.equal(out.session, undefined);
});

test("runDoctor reports agent.version null when the command fails", async () => {
  const out = await runDoctor({
    spawnSpec: { command: "nonexistent-agent-xyz-12345", args: ["acp"], options: {} },
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal(out.agent.found, false);
  assert.equal(out.agent.version, null);
});

// Through a shell the probe's spawn succeeds even for a missing launcher, so found read true.
test("runDoctor reports found false for a missing launcher run through a shell", async () => {
  const out = await runDoctor({
    spawnSpec: { command: "nonexistent-agent-xyz-12345", args: ["acp"], options: { shell: true } },
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
    probeTimeoutMs: 250,
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

// ACP_AGENT_COMMAND=node with ACP_AGENT_ARGS="<script> acp": --version replaces the acp
// subcommand and the script stays in front of it. Probing the command alone reported Node's
// own version as the agent's.
test("runDoctor keeps the launcher prefix before acp when probing the version", async () => {
  const argvPath = fileURLToPath(new URL("./fixtures/version-argv.mjs", import.meta.url));
  const probe = async (command, args) => {
    const out = await runDoctor({
      spawnSpec: { command, args, options: { shell: false } },
      getClientInfo: () => ({ capabilities: {}, version: {} }),
    });
    assert.equal(out.agent.found, true);
    assert.equal(out.agent.error, undefined);
    return out.agent.version;
  };
  assert.equal(await probe(process.execPath, [argvPath, "acp"]), '["--version"]', "the script runs, not node --version");
  assert.equal(await probe(process.execPath, [argvPath, "acp", "--trailing"]), '["--version"]', "what follows acp is dropped");
  assert.equal(await probe(argvPath, ["--stdio"]), '["--version"]', "with no acp token, --version alone");
});

test("runDoctor probes through cmd.exe with a launcher path and arguments holding spaces", { skip: process.platform !== "win32" && "cmd.exe quoting" }, async () => {
  const argvPath = fileURLToPath(new URL("./fixtures/version-argv.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "doctor launcher "));
  try {
    const launcher = join(dir, "launch me.cmd");
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${argvPath}" %*\r\n`);
    const out = await runDoctor({
      spawnSpec: { command: launcher, args: ["two words", "acp"], options: { shell: true } },
      getClientInfo: () => ({ capabilities: {}, version: {} }),
    });
    assert.equal(out.agent.error, undefined);
    assert.equal(out.agent.version, '["two words","--version"]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The probe opens stderr as a pipe. With no reader on it the launcher cannot drain its own
// write buffer and never exits, so a merely noisy launcher gets diagnosed as one that spawned
// and never answered — the same output as a wedged agent, for a healthy one.
test("runDoctor reads the version of a launcher that floods stderr", async () => {
  const floodPath = fileURLToPath(new URL("./fixtures/version-stderr-flood.js", import.meta.url));
  const started = Date.now();
  const out = await runDoctor({
    spawnSpec: { command: floodPath, args: ["acp"], options: { shell: false } },
    probeTimeoutMs: 4000,
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.ok(Date.now() - started < 4000, "the probe must not reach its timeout");
  assert.equal(out.agent.found, true);
  assert.equal(out.agent.version, "fake-agent 3.0.0");
  assert.equal(out.agent.error, undefined);
});

test("runDoctor reports the client's identity and protocol revision, not its capabilities", async () => {
  const withElicit = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({
      capabilities: { elicitation: {} },
      version: { name: "test-client", version: "1.0" },
      protocolVersion: "2026-07-28",
    }),
  });
  assert.deepEqual(withElicit.client, { name: "test-client", version: "1.0", protocolVersion: "2026-07-28" });

  const withoutElicit = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.equal("protocolVersion" in withoutElicit.client, false, "absent, not null, when the host named none");
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
  assert.equal(out.session, undefined);
  assert.equal(out.models, undefined);
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
  assert.deepEqual(out.session, { ok: true, modes: [] });
  assert.deepEqual(out.models, {
    default: DEFAULT_MODEL,
    defaultAvailable: null,
    current: null,
    available: [],
    currentModelOptions: [],
  });
  assert.ok(calls.includes("start"));
  assert.ok(calls.includes("initialize"));
  assert.ok(calls.includes("newSession"));
  assert.ok(calls.includes("stop"));
});

// model and mode are reported as models.current and session.modes, so they are dropped here.
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
  assert.deepEqual(out.models.currentModelOptions, [
    { id: "fast", values: ["false", "true"] },
    // 7 is dropped: a non-string value is not something a caller can pass back.
    { id: "thinking", values: ["high"] },
  ]);
});

// An unfamiliar id is recognizable as effort only by its name and category, and currentValue is
// the level Cursor saved for the model. Each is kept only as a string.
test("runDoctor deep:true reports option name, category and current value when sent", async () => {
  const clientFactory = () => ({
    start: async () => {},
    initialize: async () => {},
    newSession: async () => ({ sessionId: "s" }),
    stop: () => {},
    configOptions: [
      {
        id: "reasoning_effort", name: "Effort", category: "thought_level", currentValue: "high",
        options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
      },
      { id: "fast", name: 7, category: null, currentValue: false, options: [{ value: "false" }, { value: "true" }] },
    ],
  });
  const out = await runDoctor({
    deep: true,
    spawnSpec: stubSpawnSpec(),
    clientFactory,
    workspace: process.cwd(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
  });
  assert.deepEqual(out.models.currentModelOptions, [
    {
      id: "reasoning_effort", name: "Effort", category: "thought_level",
      values: ["low", "medium", "high", "xhigh"], currentValue: "high",
    },
    { id: "fast", values: ["false", "true"] },
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
  assert.equal(out.session.ok, false);
  assert.match(out.session.error, /not logged in/);
  assert.ok(out.warnings.some((w) => /handshake failed: not logged in/.test(w)));
  assert.equal(out.models, undefined);
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
  assert.equal(out.session.ok, false);
  assert.match(out.session.error, /timed out after 50ms/);
  assert.ok(stopCalls >= 1, "expected the hanging client to be stopped");
});

test("runDoctor reports the plugin version, and the env knobs only when set", async () => {
  const out = await runDoctor({
    spawnSpec: stubSpawnSpec(),
    getClientInfo: () => ({ capabilities: {}, version: {} }),
    env: { ACP_AGENT_ARGS: "acp --x", HARD_CAP_UNRELATED: "1" },
  });
  assert.equal(out.plugin.version, VERSION);
  assert.deepEqual(out.env, { ACP_AGENT_ARGS: "acp --x" });

  const quiet = await runDoctor({ spawnSpec: stubSpawnSpec(), env: {} });
  assert.equal("env" in quiet, false);
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

test("runDoctor flags a workspace that is not there", async () => {
  const out = await runDoctor({ spawnSpec: stubSpawnSpec(), workspace: join(tmpdir(), "no-such-workspace-xyz") });
  assert.equal(out.workspace.exists, false);
  assert.ok(out.warnings.some((w) => w.startsWith("workspace does not exist")));
});

const ACCOUNT_STUB = fileURLToPath(new URL("./fixtures/account-stub.js", import.meta.url));
const accountSpec = (mode) => ({ command: process.execPath, args: [ACCOUNT_STUB, mode, "acp"], options: { shell: false } });

test("runDoctor reads login and plan from the CLI, and no email", async () => {
  const out = await runDoctor({ spawnSpec: accountSpec("signed-in") });
  assert.deepEqual(out.auth, { status: "ok", plan: "Plus" });
  assert.deepEqual(out.warnings, []);
  assert.equal("latestVersion" in out.agent, false);
  assert.doesNotMatch(JSON.stringify(out), /someone@example\.com/);
});

test("runDoctor reports a logged-out CLI with what to run", async () => {
  const out = await runDoctor({ spawnSpec: accountSpec("logged-out") });
  assert.deepEqual(out.auth, { status: "logged-out" });
  assert.ok(out.warnings.includes("cursor-agent is not logged in. Run `cursor-agent login`."));
});

test("runDoctor names a newer CLI release", async () => {
  const out = await runDoctor({ spawnSpec: accountSpec("outdated") });
  assert.equal(out.agent.latestVersion, "2026.11.30-aaaaaaa");
  assert.ok(out.warnings.includes("cursor-agent 2026.11.30-aaaaaaa is available. Run `cursor-agent update`."));
});

test("runDoctor reads login as unknown from a CLI that does not answer status", async () => {
  const out = await runDoctor({ spawnSpec: stubSpawnSpec() });
  assert.deepEqual(out.auth, { status: "unknown" });
  assert.deepEqual(out.warnings, []);
});

test("runDoctor warns about a launcher it cannot find", async () => {
  const out = await runDoctor({ spawnSpec: { command: "nonexistent-agent-xyz-12345", args: ["acp"], options: {} } });
  assert.deepEqual(out.auth, { status: "unknown" });
  assert.ok(out.warnings.some((w) => /not found/.test(w)));
});

test("runDoctor deep:true reports the models and modes the session offers", async () => {
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
  assert.deepEqual(out.session, { ok: true, modes: ["agent", "plan", "ask"] });
  assert.equal(out.models.current, "composer-2.5");
  assert.deepEqual(out.models.available, ["composer-2.5", "claude-opus-4-8"]);
  assert.equal(out.models.defaultAvailable, true);
  assert.equal(out.warnings.length, 0);
});

test("runDoctor deep:true warns when the account does not offer the default model", async () => {
  const clientFactory = () => ({
    start: async () => {},
    initialize: async () => {},
    newSession: async function () {
      this.sessionModels = { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7" }] };
      return { sessionId: "s" };
    },
    stop: () => {},
  });
  const out = await runDoctor({ deep: true, spawnSpec: stubSpawnSpec(), clientFactory });
  assert.equal(out.models.defaultAvailable, false);
  assert.ok(out.warnings.some((w) => w.startsWith(`The default model ${DEFAULT_MODEL} is not among the models this account offers`)));
});

// Runs fn with CURSOR_TEST_PIDLOG set, handing it the pids hang-pid-stub.js has logged so far.
async function withPidLog(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cdm-pidlog-"));
  const log = join(dir, "pids");
  const saved = process.env.CURSOR_TEST_PIDLOG;
  process.env.CURSOR_TEST_PIDLOG = log;
  const pids = () => {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => Number(line.split(" ")[0])); } catch { return []; }
  };
  try {
    return await fn(pids);
  } finally {
    if (saved === undefined) delete process.env.CURSOR_TEST_PIDLOG; else process.env.CURSOR_TEST_PIDLOG = saved;
    for (const pid of pids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
}
const HANG_PID_STUB = fileURLToPath(new URL("./fixtures/hang-pid-stub.js", import.meta.url));
const until = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
};

test("runDoctor deep stops the agent at once when the host aborts", async () => {
  const controller = new AbortController();
  let client;
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const out = await rawRunDoctor({
    deep: true, signal: controller.signal, handshakeTimeoutMs: 10000,
    spawnSpec: { command: process.execPath, args: ["--version"], options: { shell: false } },
    clientFactory: (opts) => (client = new AcpClient({
      ...opts,
      spawnSpec: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/handshake-hang-stub.js", import.meta.url))], options: { shell: false } },
    })),
  });
  assert.ok(Date.now() - started < 3000, `doctor took ${Date.now() - started} ms after the abort`);
  assert.equal(out.session.ok, false);
  assert.match(out.session.error, /aborted/);
  assert.ok(!isChildAlive(client.child));
});

test("runDoctor stops the version probe on a host abort, and spawns no handshake agent after it", async () => {
  await withPidLog(async (pids) => {
    const controller = new AbortController();
    let spawned = 0;
    const run = rawRunDoctor({
      deep: true, signal: controller.signal, probeTimeoutMs: 10000, handshakeTimeoutMs: 10000,
      spawnSpec: { command: HANG_PID_STUB, args: ["acp"], options: { shell: false } },
      clientFactory: () => { spawned++; throw new Error("no agent may be spawned after the abort"); },
    });
    await until(() => pids().length === 1);
    const started = Date.now();
    controller.abort();
    const out = await run;
    assert.ok(Date.now() - started < 3000, `doctor took ${Date.now() - started} ms after the abort`);
    assert.match(out.agent.error ?? "", /aborted/);
    assert.equal(out.session.ok, false);
    assert.match(out.session.error, /aborted/);
    assert.equal(spawned, 0);
    assert.equal(pids().length, 1);
  });
});

test("runDoctor spawns no version probe once the host has aborted", async () => {
  await withPidLog(async (pids) => {
    const controller = new AbortController();
    controller.abort();
    const out = await rawRunDoctor({
      signal: controller.signal,
      spawnSpec: { command: HANG_PID_STUB, args: ["acp"], options: { shell: false } },
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(pids(), [], "nothing may be spawned for a doctor that was already aborted");
    assert.equal(out.agent.found, true, "found comes from the lookup alone");
    assert.equal(out.agent.version, null);
    assert.match(out.agent.error ?? "", /aborted/);
  });
});

test("shutdown's stopAll ends a hung version probe, and a probe after it is not started", async () => {
  await withPidLog(async (pids) => {
    const registry = createChildRegistry();
    const spec = { command: HANG_PID_STUB, args: [], options: { shell: false } };
    const run = probeAgentVersion(spec, 10000, { registry });
    await until(() => pids().length === 1);
    await registry.stopAll();
    assert.throws(() => process.kill(pids()[0], 0), "the probe must be gone when stopAll resolves");
    await run;
    const late = await probeAgentVersion(spec, 10000, { registry });
    assert.deepEqual(late, { found: true, version: null, error: "the server is shutting down, so no process was started" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pids().length, 1, "the late probe must not start");
  });
});
