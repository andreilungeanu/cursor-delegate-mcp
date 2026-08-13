import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { isChildAlive } from "../src/proc.js";

// process.kill(pid, 0) probes without signalling. EPERM means the pid is taken by a process we
// may not signal, which still counts as alive; ESRCH is the only "gone". A killed orphan whose
// reaper has not run keeps its pid as a zombie, so on Linux the state decides — otherwise a
// suite run where the runner is itself pid 1 reads every dead descendant as alive.
function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (err) { return err.code === "EPERM"; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return true; }
}

async function until(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function fakeSpawn() {
  // fileURLToPath (not .pathname) is required on Windows: pathname yields a
  // leading-slash form ("/D:/...") that node.exe mis-resolves as a relative
  // path, double-prefixing the drive letter when spawned.
  return { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-acp.js", import.meta.url))], options: { shell: false } };
}

test("client initializes, opens a session, prompts and emits updates", async () => {
  const updates = [];
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  client.on("update", (u) => updates.push(u));
  // The wire assertion below reads the flight recorder, which is opt-in and reads the flag when
  // start() builds the peer.
  const prevTranscript = process.env.CURSOR_DELEGATE_TRANSCRIPT;
  process.env.CURSOR_DELEGATE_TRANSCRIPT = "50";
  try { await client.start(); }
  finally {
    if (prevTranscript === undefined) delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
    else process.env.CURSOR_DELEGATE_TRANSCRIPT = prevTranscript;
  }
  const caps = await client.initialize();
  assert.equal(caps.protocolVersion, 1);
  assert.equal(caps._meta.parameterizedModelPicker, true);
  const s = await client.newSession(process.cwd());
  assert.equal(s.sessionId, "sess-1");
  await client.setModel(s.sessionId, "composer-2.5");
  await client.setConfigOption(s.sessionId, "fast", false);
  await client.setMode(s.sessionId, "agent");
  const res = await client.prompt(s.sessionId, [{ type: "text", text: "do it" }]);
  assert.equal(res.stopReason, "end_turn");
  assert.equal(updates.at(-1).update.sessionUpdate, "agent_message_chunk");
  // boolean fast is stringified at the ACP boundary
  const fastFrame = client.peer.getLog().find((e) => e.dir === "out" && e.line.includes("set_config_option"));
  assert.equal(JSON.parse(fastFrame.line).params.value, "false");
  client.stop();
});

test("captures stderr and surfaces it on exit", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: ["-e", "process.stderr.write('stderr-line\\n'); process.exit(3);"],
      options: { shell: false },
    },
  });
  const exit = new Promise((resolve) => client.once("exit", resolve));
  await client.start();
  const info = await exit;
  assert.equal(info.code, 3);
  assert.match(info.stderr, /stderr-line/);
  client.stop();
});

// Spawn failure was the one untagged failure class: every other error carries a reason,
// so the server rendered this one as a bare "delegate failed:" with no [reason].
test("start() rejects a failed spawn with reason spawn-failed", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: "definitely-not-a-real-command-xyz",
      args: [],
      options: { shell: false },
    },
  });
  await assert.rejects(
    () => client.start(),
    (err) => {
      assert.equal(err.reason, "spawn-failed");
      assert.match(err.message, /Failed to spawn agent \(definitely-not-a-real-command-xyz\)/);
      return true;
    }
  );
  client.stop();
});

test("stop() terminates a live agent child (regression: Windows orphaned agent)", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/silent-stub.js", import.meta.url))],
      options: { shell: false },
    },
  });
  await client.start();
  assert.ok(isChildAlive(client.child), "child must be alive before stop()");
  const exited = new Promise((resolve) => client.child.once("exit", resolve));
  client.stop();
  await exited;
  assert.ok(!isChildAlive(client.child), "child must be dead after stop()");
});

// The agent spawns its own children; killing one pid orphans them. Windows taskkill /T already
// takes the tree, so this only fails on POSIX until treeKill kills the process group there.
test("stop() kills the agent's descendants, not only the direct child", async () => {
  const pidFile = join(tmpdir(), `cdm-grandchild-${process.pid}-${Date.now()}`);
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/spawns-grandchild.js", import.meta.url)), pidFile],
      options: { shell: false },
    },
  });
  let grandchildPid;
  try {
    await client.start();
    const readPid = () => {
      try {
        const raw = readFileSync(pidFile, "utf8");
        return raw.endsWith("\n") ? Number(raw.trim()) : undefined;
      } catch { return undefined; }
    };
    await until(() => readPid() !== undefined, 5000, "fixture never reported a grandchild pid");
    grandchildPid = readPid();
    assert.ok(pidAlive(grandchildPid), "grandchild must be alive before stop()");
    const exited = new Promise((resolve) => client.child.once("exit", resolve));
    client.stop();
    await exited;
    await until(() => !pidAlive(grandchildPid), 5000, "grandchild survived stop()");
  } finally {
    if (grandchildPid && pidAlive(grandchildPid)) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} }
    rmSync(pidFile, { force: true });
  }
});

function silentStub() {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/silent-stub.js", import.meta.url))],
    options: { shell: false },
  };
}

test("stop() is idempotent and reports the exit it observed", async () => {
  const client = new AcpClient({ spawnSpec: silentStub() });
  await client.start();
  const first = client.stop();
  assert.equal(client.stop(), first, "a second caller must join the same teardown, not start one");
  assert.equal(await first, true, "the child was observed to exit");
  assert.equal(await client.stop(), true, "a later caller gets the same answer");
});

// A dispatched signal is not an exit, and cancel reports "killed" only for the second one. A real
// agent cannot be made to swallow SIGKILL, so the exit event is withheld instead: the pid stays
// real and is still killed, and only the notification this waits on goes missing.
test("stop() reports false when no exit lands within the bound", async () => {
  const client = new AcpClient({ spawnSpec: silentStub() });
  await client.start();
  const child = client.child;
  const reallyExited = new Promise((resolve) => child.once("exit", resolve));
  client.child = { pid: child.pid, exitCode: null, signalCode: null, once: () => {} };
  assert.equal(await client.stop({ timeoutMs: 25 }), false, "an exit that never arrives is not observed");
  await reallyExited;
});

test("cancel sends session/cancel as a notification without id", async () => {
  const written = [];
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  await client.start();
  const origWrite = client.peer.output.write.bind(client.peer.output);
  client.peer.output.write = (chunk) => {
    written.push(chunk.toString());
    return origWrite(chunk);
  };
  await client.cancel("sess-1");
  const msg = JSON.parse(written.at(-1).trim());
  assert.equal(msg.method, "session/cancel");
  assert.deepEqual(msg.params, { sessionId: "sess-1" });
  assert.equal(msg.id, undefined);
  client.stop();
});
