import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// An exit a missed kill leaves unanswered fails the test instead of holding the file open.
async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
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

// Under shell:true Node hands cmd.exe one unquoted line, so a launcher path with a space failed
// to resolve and a quoted ACP_AGENT_ARGS segment arrived split. The child reports the argv it got.
test("start() passes a launcher path and arguments with spaces through cmd.exe intact", { skip: process.platform !== "win32" && "cmd.exe quoting" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp launcher "));
  try {
    writeFileSync(join(dir, "argv-dump.js"), "process.stderr.write(JSON.stringify(process.argv.slice(2))); process.exit(3);\n");
    const launcher = join(dir, "launch me.cmd");
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0argv-dump.js" %*\r\n`);
    const args = ["two words", "C:\\trailing dir\\", "a&b", "", "acp"];
    // Unquoted as most users write it, and pre-quoted as the old workaround had them write it.
    for (const command of [launcher, `"${launcher}"`]) {
      const client = new AcpClient({ spawnSpec: { command, args, options: { shell: true } } });
      const exit = new Promise((resolve) => client.once("exit", resolve));
      await client.start();
      const info = await exit;
      assert.equal(info.code, 3, `launcher must run (${command}): ${info.stderr}`);
      assert.deepEqual(JSON.parse(info.stderr), args);
      await client.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Mirrors STDERR_CAP in src/acp-client.js. The cap is the contract this pins, so it is stated
// here rather than imported from the module under test.
const STDERR_CAP = 64 * 1024;

// The trim only runs past the cap, which no other test reaches. What it bounds is retained memory:
// stderrBuffer slices to the cap on every read regardless, so deleting the trim changes nothing an
// exit message shows and is visible only in what the client still holds — hence the private read.
test("stderr past the cap keeps a full newest-bytes window without retaining the flood", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/stderr-flood.js", import.meta.url))],
      options: { shell: false },
    },
  });
  try {
    await client.start();
    await until(() => client.stderrBuffer.endsWith("FLOOD-END\n"), 10000, "the flood never arrived");
    assert.equal(client.stderrBuffer.length, STDERR_CAP, "the reported tail is exactly one cap window");
    assert.ok(!client.stderrBuffer.includes("FLOOD-START"), "the oldest stderr is gone from the tail");
    // An absolute bound rather than a comparison against the front chunk, which a single-chunk
    // delivery would satisfy with the trim deleted. Whole-chunk drops alone can leave almost two
    // caps when a pipe read is larger than 64KB; the overflow slice keeps retained memory to one.
    assert.ok(
      client._stderrLength <= STDERR_CAP,
      `retained ${client._stderrLength} bytes across ${client._stderrChunks.length} chunks`
    );
  } finally {
    await client.stop();
  }
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

// How the bridge launches cursor-agent on Windows: through cmd.exe, which always spawns. Without
// the PATH check a missing launcher surfaced as agent-exit quoting cmd's localized "is not
// recognized" line, and the spawn-failed install hint never fired. Measured live on 2.8.0.
test("start() reports a missing launcher as spawn-failed when it runs through a shell", async () => {
  const client = new AcpClient({
    spawnSpec: { command: "definitely-not-a-real-command-xyz", args: ["acp"], options: { shell: true } },
  });
  await assert.rejects(() => client.start(), (err) => {
    assert.equal(err.reason, "spawn-failed");
    assert.match(err.message, /not found on PATH\. Install Cursor CLI/);
    return true;
  });
  await client.stop();
});

// The launcher is looked up on the PATH the agent is spawned with (agentEnv() on win32), not on
// this process's: node is on this process's PATH but not on the one handed to the shell.
test("start() resolves a shell-launched command against the spawn env, not process.env", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "acp-empty-path-"));
  const client = new AcpClient({
    spawnSpec: { command: "node", args: ["-e", ""], options: { shell: true, env: { PATH: emptyDir } } },
  });
  try {
    await assert.rejects(() => client.start(), (err) => {
      assert.equal(err.reason, "spawn-failed");
      assert.match(err.message, /Failed to spawn agent \(node\): not found on PATH/);
      return true;
    });
  } finally {
    await client.stop();
    rmSync(emptyDir, { recursive: true, force: true });
  }
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
  try {
    client.stop();
    await within(exited, 10000, "the agent never exited");
    assert.ok(!isChildAlive(client.child), "child must be dead after stop()");
  } finally {
    try { client.child.kill("SIGKILL"); } catch {}
  }
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
    await within(exited, 10000, "the agent never exited");
    await until(() => !pidAlive(grandchildPid), 5000, "grandchild survived stop()");
  } finally {
    try { client.child?.kill("SIGKILL"); } catch {}
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
  try {
    const first = client.stop();
    assert.equal(client.stop(), first, "a second caller must join the same teardown, not start one");
    assert.equal(await first, true, "the child was observed to exit");
    assert.equal(await client.stop(), true, "a later caller gets the same answer");
  } finally {
    try { client.child.kill("SIGKILL"); } catch {}
  }
});

// A real agent cannot swallow SIGKILL, so its exit is hidden, as a failed kill would leave it; the
// pid is still killed. Resolves on the real exit, with a function that shows it.
function withholdExit(child) {
  const real = {};
  for (const field of ["exitCode", "signalCode"]) {
    real[field] = child[field];
    Object.defineProperty(child, field, { get: () => null, set: (value) => { real[field] = value; }, configurable: true });
  }
  const reveal = () => {
    for (const field of Object.keys(real)) Object.defineProperty(child, field, { value: real[field], writable: true, configurable: true });
  };
  return new Promise((resolve) => {
    const emit = child.emit;
    child.emit = function (event, ...args) {
      if (event === "exit") resolve(reveal);
      if (event === "exit" || event === "close") return false;
      return emit.call(this, event, ...args);
    };
  });
}

// With the exit withheld, emitExit never runs either: nothing but stop() rejects session/prompt.
test("stop() rejects in-flight RPCs when the child does not exit", async () => {
  const client = new AcpClient({ spawnSpec: silentStub() });
  await client.start();
  await client.initialize();
  const session = await client.newSession(process.cwd());
  const prompt = client.prompt(session.sessionId, [{ type: "text", text: "hang" }]);
  prompt.catch(() => {});
  const reallyExited = withholdExit(client.child);
  try {
    assert.equal(client.peer.pending.size, 1, "session/prompt must still be in flight");
    assert.equal(await client.stop(), false, "an exit that never arrives is not observed");
    let timeoutId;
    try {
      const err = await Promise.race([
        prompt.then(
          () => { throw new Error("session/prompt resolved after a missed exit"); },
          (e) => e
        ),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("session/prompt still pending after stop()")), 200);
        }),
      ]);
      assert.equal(err.reason, "agent-exit");
      assert.match(err.message, /did not exit after stop/);
      assert.equal(client.peer.pending.size, 0, "the missed exit must not leave the RPC pending");
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    try { client.peer?.rejectAllPending(new Error("test cleanup")); } catch {}
    try { client.child.kill("SIGKILL"); } catch {}
    await within(reallyExited, 10000, "the kill never landed");
  }
});

// The agent answers every request 200 ms late, so the reply lands after endTurn().
test("a setup reply that lands once the delegation ended is refused", async () => {
  const script = "require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l);"
    + " if (m.id !== undefined) setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } }) + '\\n'), 200); });";
  const client = new AcpClient({ spawnSpec: { command: process.execPath, args: ["-e", script], options: { shell: false } } });
  await client.start();
  try {
    const reply = client.initialize();
    client.endTurn();
    await assert.rejects(reply, { reason: "wire-closed" });
    assert.equal(client.protocolVersion, undefined);
  } finally {
    await client.stop();
  }
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

test("stderr is captured but is not reported as agent activity", async () => {
  // The supervisor's clock feeds the heartbeat's "last agent frame N ago" and the stall error's
  // "Last ACP frame N ago"; a launcher writing diagnostics on stderr is not the turn progressing.
  const script = 'setInterval(() => process.stderr.write("still booting\\n"), 20);';
  const client = new AcpClient({ spawnSpec: { command: process.execPath, args: ["-e", script] } });
  let activity = 0;
  client.on("activity", () => { activity++; });
  await client.start();
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(activity, 0, "stderr chatter must not read as agent activity");
    assert.match(client.stderrBuffer, /still booting/, "and it must still be captured for the exit error");
  } finally {
    // The stub never exits on its own, so a failed assertion above would otherwise leave it
    // running and the runner waiting on its pipes.
    await client.stop();
  }
});

test("the exit error carries the whole of stderr, not a tail of it", async () => {
  // The reason a run failed can sit anywhere in the agent's stderr — a rejected model, an
  // expired login, a quota and when it resets. A byte cut here drops the half that names it.
  // The 64KB ring buffer is what bounds this; nothing below it needs a second cut. Read off
  // the rejection the client raises, not off a message the test builds.
  const marker = "REASON-AT-THE-FRONT";
  const noisy = marker + "M".repeat(4000);
  const script = `process.stderr.write(${JSON.stringify(noisy)}); setTimeout(() => process.exit(3), 150);`;
  const client = new AcpClient({ spawnSpec: { command: process.execPath, args: ["-e", script] } });
  await client.start();

  // Never answered, so the exit handler is what settles it.
  const err = await client.peer.request("initialize", {}).then(() => null, (e) => e);

  assert.equal(err?.reason, "agent-exit");
  assert.ok(err.message.includes(marker), "the front of stderr must survive into the exit error");
  assert.ok(err.message.length > 2000, `the whole of stderr must be carried, got ${err.message.length} chars`);
});

test("each request goes on the wire through the method that owns its phase", () => {
  const owners = new Set(["_setup", "prompt"]);
  const lines = readFileSync(fileURLToPath(new URL("../src/acp-client.js", import.meta.url)), "utf8").split("\n");
  let method;
  const outside = [];
  lines.forEach((line, i) => {
    method = /^ {2}(?:async )?([_a-zA-Z]\w*)\(.*\) \{/.exec(line)?.[1] ?? method;
    if (/\bpeer\.request\(/.test(line) && !owners.has(method)) outside.push(`src/acp-client.js:${i + 1} in ${method}()`);
  });
  assert.deepEqual(outside, [], `${outside.join(", ")} calls peer.request directly. A request before the task prompt goes through _setup(), which refuses it once setup ended; a prompt goes through prompt().`);
});
