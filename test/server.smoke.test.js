import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("../src/server.js", import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const GRANDCHILD_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-with-grandchild.js", import.meta.url));
const STREAMING_AGENT = fileURLToPath(new URL("./fixtures/streaming-stub.js", import.meta.url));
const HANG_PID_AGENT = fileURLToPath(new URL("./fixtures/hang-pid-stub.js", import.meta.url));

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
};

// The bin is a stdio server, so an unrecognised flag starts the transport and waits on stdin.
// The version has to come back without a host attached, and it has to be the version of this
// code rather than whatever a manifest pinned.
test("the binary answers --version and exits without starting the transport", async () => {
  // -v too: it is what a hand check reaches for, and falling through to the transport there
  // reads exactly like the wedged install the flag exists to rule out.
  for (const flag of ["--version", "-v"]) {
    const { stdout } = await run(process.execPath, [ENTRY, flag], { timeout: 10000 });
    assert.equal(stdout.trim(), PKG.version, `${flag} must print the version`);
  }
});

// A one-shot host closes stdin as soon as the result arrives, and the server exits on that EOF.
test("a host that closes right after a delegate result leaves no agent process behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdm-oneshot-"));
  const pidFile = join(dir, "pids");
  const client = new Client({ name: "oneshot-host", version: "1" });
  let pids = [];
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${GRANDCHILD_AGENT}"`, PID_FILE: pidFile },
      stderr: "ignore",
    }));
    const res = await client.callTool({ name: "delegate", arguments: { workspace: dir, spec: "x" } });
    await client.close();
    assert.equal(res.isError, undefined, res.content[0].text);
    pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    // Room for a kill still in flight to land, so only one that never comes fails the test.
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(pids.filter(isAlive), [], "the agent and its descendants must be gone");
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});

// The bin over stdio in raw 2026-07-28 JSON-RPC, as Claude Code speaks it: the SDK client fails a
// call answered with a task.
function rawServer(env) {
  const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  // A test can still be writing when the server has already shut down: EPIPE, not a failure.
  child.stdin.on("error", () => {});
  const replies = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id != null && replies.has(m.id)) { replies.get(m.id)(m); replies.delete(m.id); }
  });
  const send = (method, params = {}) => {
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} in 15 s`)), 15000);
      replies.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } },
      "io.modelcontextprotocol/clientInfo": { name: "raw-host", version: "1" },
    } } }) + "\n");
    return reply;
  };
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, send, exited };
}

// The delegation's agent holds shutdown open while doctor's probe is killed, so doctor reaches its
// handshake during the shutdown, as it does on a busy server.
test("a signal during doctor's deep probe leaves no agent running after the server exits", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdm-doctor-signal-"));
  const pidLog = join(dir, "pids");
  const { child, send, exited } = rawServer({
    ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${HANG_PID_AGENT}" acp`, CURSOR_TEST_PIDLOG: pidLog,
  });
  const started = () => { try { return readFileSync(pidLog, "utf8").trim().split("\n"); } catch { return []; } };
  const until = async (n) => {
    const deadline = Date.now() + 10000;
    while (started().length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  };
  try {
    await send("server/discover");
    send("tools/call", { name: "delegate", arguments: { workspace: dir, spec: "x" } }).catch(() => {});
    await until(1);
    send("tools/call", { name: "doctor", arguments: { deep: true } }).catch(() => {});
    await until(2);
    assert.match(started()[1], /--version/, "doctor's version probe is running when the signal lands");
    child.kill("SIGTERM");
    await exited;
    await new Promise((r) => setTimeout(r, 1000));
    const alive = started().filter((line) => isAlive(Number(line.split(" ")[0])));
    assert.deepEqual(alive, [], "an agent outlived the server");
  } finally {
    child.kill();
    for (const line of started()) { try { process.kill(Number(line.split(" ")[0]), "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the binary answers a delegate call listing the tasks extension with a task that completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdm-task-"));
  const { child, send, exited } = rawServer({ ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${STREAMING_AGENT}"` });
  try {
    const discover = await send("server/discover");
    assert.deepEqual(discover.result.capabilities.extensions?.["io.modelcontextprotocol/tasks"], {});
    const call = await send("tools/call", { name: "delegate", arguments: { workspace: dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    let task;
    const deadline = Date.now() + 15000;
    do {
      await new Promise((r) => setTimeout(r, 100));
      task = (await send("tasks/get", { taskId: call.result.taskId })).result;
    } while (task.status === "working" && Date.now() < deadline);
    assert.equal(task.status, "completed");
    assert.equal(JSON.parse(task.result.content[0].text).sessionId, "sess-stream");
  } finally {
    child.stdin.end();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host that closes mid-task leaves no agent process behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdm-task-close-"));
  const pidFile = join(dir, "pids");
  const { child, send, exited } = rawServer({
    ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${GRANDCHILD_AGENT}"`, AGENT_BASE: "./escalation-stub.js", PID_FILE: pidFile,
  });
  let pids = [];
  try {
    await send("server/discover");
    const call = await send("tools/call", { name: "delegate", arguments: { workspace: dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    assert.deepEqual(pids.filter(isAlive), pids, "the agent should be running when the host leaves");
    child.stdin.end();
    await exited;
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(pids.filter(isAlive), [], "the agent and its descendants must be gone");
  } finally {
    child.kill();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});

// A host that dies breaks the server's stdout first; the transport then pauses stdin, so no 'end'.
test("a host whose stdout pipe breaks mid-task leaves no agent process behind", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdm-task-epipe-"));
  const pidFile = join(dir, "pids");
  const { child, send, exited } = rawServer({
    ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${GRANDCHILD_AGENT}"`, AGENT_BASE: "./escalation-stub.js", PID_FILE: pidFile,
  });
  let pids = [];
  try {
    await send("server/discover");
    const call = await send("tools/call", { name: "delegate", arguments: { workspace: dir, spec: "x" } });
    assert.equal(call.result.resultType, "task", JSON.stringify(call));
    pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    assert.deepEqual(pids.filter(isAlive), pids, "the agent should be running when the host leaves");
    child.stdout.destroy();
    for (let i = 0; i < 5; i++) {
      send("tasks/get", { taskId: call.result.taskId }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 20000))]);
    assert.notEqual(code, "still running", "the server outlived its host");
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(pids.filter(isAlive), [], "the agent and its descendants must be gone");
  } finally {
    child.kill();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    // A still-running agent holds the folder as its cwd on Windows until the kill lands.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
});
