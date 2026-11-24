import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createChildRegistry, isChildAlive, spawnChild, treeKill } from "../src/proc.js";

const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups" : false };
const win32Only = { skip: process.platform === "win32" ? false : "windows taskkill" };

/** Record what treeKill signals on POSIX, without signalling anything. */
async function recordKills(pid, options) {
  const realKill = process.kill;
  const calls = [];
  process.kill = (target, signal) => {
    calls.push({ target, signal });
  };
  try {
    await treeKill(pid, options);
  } finally {
    process.kill = realKill;
  }
  return calls;
}

test("isChildAlive is false once the child has exited", () => {
  assert.equal(isChildAlive({ exitCode: null, signalCode: null }), true);
  assert.equal(isChildAlive({ exitCode: 0, signalCode: null }), false);
  assert.equal(isChildAlive({ exitCode: null, signalCode: "SIGKILL" }), false);
});

test("treeKill signals nothing without a pid", async () => {
  assert.deepEqual(await recordKills(undefined, { childAlive: true }), []);
  assert.deepEqual(await recordKills(0, { childAlive: true }), []);
});

test("the group is signalled even after the leader has exited", posixOnly, async () => {
  // The whole point of detaching: a group outlives its leader, so the agent can be gone while
  // the commands it started are still in the group, and the group is the only handle left.
  assert.deepEqual(await recordKills(4242, { childAlive: false }), [{ target: -4242, signal: "SIGKILL" }]);
});

test("the bare pid is only signalled while the child is alive", posixOnly, async () => {
  assert.deepEqual(await recordKills(4242, { childAlive: true }), [
    { target: -4242, signal: "SIGKILL" },
    { target: 4242, signal: "SIGKILL" },
  ]);
});

// Real processes below. Recording call shape would not notice that taskkill fired at all, which
// is the whole of the Windows gate: there is no group there, so the bare pid is all it ever has.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const startVictim = async () => {
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(alive(victim.pid), "the victim must be running before the kill");
  return victim;
};

test("the windows kill does not fire once the child has exited", win32Only, async () => {
  // Stands in for a pid that was reaped and recycled: treeKill is told the child is gone, so
  // whatever holds that pid now is somebody else's process.
  const victim = await startVictim();
  try {
    await treeKill(victim.pid, { childAlive: false });
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(alive(victim.pid), true, "treeKill killed a pid it was told was no longer the child");
  } finally {
    try { victim.kill(); } catch {}
  }
});

test("the windows kill still fires while the child is alive", win32Only, async () => {
  const victim = await startVictim();
  try {
    await treeKill(victim.pid, { childAlive: true });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && alive(victim.pid)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(victim.pid), false, "the gate swallowed a kill that should have landed");
  } finally {
    try { victim.kill(); } catch {}
  }
});

// taskkill replaced by a real process running script, which kills nothing.
function swapTaskkill(script) {
  const cp = createRequire(import.meta.url)("node:child_process");
  const real = cp.execFile;
  const utilities = [];
  cp.execFile = (file, args, opts, cb) => {
    if (file !== "taskkill") return real(file, args, opts, cb);
    const utility = real(process.execPath, ["-e", script], opts, cb);
    utilities.push(utility);
    return utility;
  };
  syncBuiltinESMExports();
  return {
    utilities,
    restore: () => {
      cp.execFile = real;
      syncBuiltinESMExports();
      for (const u of utilities) { try { u.kill("SIGKILL"); } catch {} }
    },
  };
}

const startTracked = (registry) => spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { shell: false }, { stdio: "ignore" }, registry);

// The launcher dies by its handle, but what it started is out of reach: the stop stays unconfirmed,
// so the caller still warns that it may be running.
test("a taskkill that fails still ends the launcher, by its own handle, and the stop stays unconfirmed", win32Only, async () => {
  const swap = swapTaskkill("process.exit(1)");
  const registry = createChildRegistry();
  /** @type {any[]} */
  const kills = [];
  const tracked = startTracked({ track: (start) => registry.track(() => { const kill = start(); kills.push(kill); return kill; }) });
  try {
    assert.equal(await tracked.stop(), false, "a failed taskkill was taken for a clean stop");
    assert.equal(isChildAlive(tracked.child), false, "the launcher outlived the stop");
    assert.equal(kills[0].spent(), true, "the dead launcher is still counted as reachable");
    assert.equal(await tracked.stop(), false, "a later stop took the dead launcher for a clean stop");
  } finally {
    swap.restore();
    try { tracked.child.kill("SIGKILL"); } catch {}
  }
});

// The launcher's handle kill is made to miss, so the stop's retry finds it alive.
test("a retry after a failed taskkill does not run taskkill again", win32Only, async () => {
  const swap = swapTaskkill("process.exit(1)");
  const tracked = startTracked(createChildRegistry());
  const kill = tracked.child.kill.bind(tracked.child);
  tracked.child.kill = () => false;
  try {
    assert.equal(await tracked.stop({ timeoutMs: 600 }), false);
    assert.equal(swap.utilities.length, 1, "the retry started a second taskkill");
  } finally {
    swap.restore();
    kill("SIGKILL");
  }
});

test("a taskkill that stalls is stopped, and the launcher killed by its own handle", win32Only, async () => {
  const swap = swapTaskkill("setInterval(() => {}, 1000)");
  const tracked = startTracked(createChildRegistry());
  const started = Date.now();
  try {
    assert.equal(await tracked.stop(), false, "a stalled taskkill was taken for a clean stop");
    assert.equal(isChildAlive(tracked.child), false, "the launcher outlived the stop");
    assert.ok(Date.now() - started < 3900, `the stop took ${Date.now() - started} ms`);
    assert.equal(swap.utilities.length, 1, "a retry started a second taskkill");
    assert.notEqual(swap.utilities[0].signalCode ?? swap.utilities[0].exitCode, null, "the stalled taskkill is still running");
  } finally {
    swap.restore();
    try { tracked.child.kill("SIGKILL"); } catch {}
  }
});

test("treeKill reports a taskkill that failed, and one that found no such process as done", win32Only, async () => {
  for (const [code, expected] of [[1, false], [128, true]]) {
    const swap = swapTaskkill(`process.exit(${code})`);
    try {
      assert.equal(await treeKill(4242, { childAlive: true }), expected, `taskkill exit ${code}`);
    } finally {
      swap.restore();
    }
  }
});

// A tracked child whose kill attempts end as scripted: true or false is the exit seen or not,
// "reject" and "throw" a kill that failed.
function scripted(registry, outcomes) {
  const calls = { attempts: 0 };
  const entry = registry.track(() => ({
    kill: () => {
      calls.attempts++;
      const outcome = outcomes.shift();
      if (outcome === "throw") throw new Error("kill threw");
      if (outcome === "reject") return Promise.reject(new Error("kill failed"));
      return outcome instanceof Promise ? outcome : Promise.resolve(outcome);
    },
  }));
  return { entry, calls };
}

test("a stop retries an attempt that missed the exit once, and the next stop kills again", async () => {
  const { entry, calls } = scripted(createChildRegistry(), [false, false, "reject", "throw", false, true]);
  assert.equal(await entry.stop(), false);
  assert.equal(calls.attempts, 2);
  assert.equal(await entry.stop(), false, "a rejected and a thrown kill are exits not seen");
  assert.equal(calls.attempts, 4);
  assert.equal(await entry.stop(), true);
  assert.equal(calls.attempts, 6);
  assert.equal(await entry.stop(), true);
  assert.equal(calls.attempts, 6, "a stop that saw the exit is not repeated");
});

test("a failed stop with nothing left to reach leaves the registry, and later stops still report it", async () => {
  const registry = createChildRegistry();
  let attempts = 0;
  const entry = registry.track(() => ({ kill: async () => { attempts++; return false; }, spent: () => true }));
  assert.equal(await entry.stop(), false);
  assert.equal(await entry.stop(), false);
  await registry.stopAll();
  assert.equal(attempts, 2, "the registry kept stopping a child no kill can reach");
});

test("callers join a stop in flight", async () => {
  let seen;
  const { entry, calls } = scripted(createChildRegistry(), [new Promise((r) => { seen = r; })]);
  const stops = [entry.stop(), entry.stop()];
  seen(true);
  assert.deepEqual(await Promise.all(stops), [true, true]);
  assert.equal(calls.attempts, 1);
});

test("release drops a child no stop is running on, and leaves one whose stop is under way to it", async () => {
  const registry = createChildRegistry();
  const closed = scripted(registry, []);
  closed.entry.release();
  assert.equal(await closed.entry.stop(), true);
  assert.equal(closed.calls.attempts, 0, "a released child is not killed");
  let seen;
  const stopping = scripted(registry, [new Promise((r) => { seen = r; }), true]);
  const stop = stopping.entry.stop();
  stopping.entry.release();
  seen(false);
  assert.equal(await stop, true, "the stop under way retried its missed exit");
  assert.equal(stopping.calls.attempts, 2);
});

test("stopAll waits for every stop, and the registry then refuses a spawn without starting it", async () => {
  const registry = createChildRegistry();
  scripted(registry, [new Promise((r) => setTimeout(() => r(true), 100))]);
  const missed = scripted(registry, [false, false]);
  const started = Date.now();
  await registry.stopAll();
  assert.ok(Date.now() - started >= 90, "stopAll resolved before the slow stop settled");
  assert.equal(missed.calls.attempts, 2);
  let spawned = false;
  assert.throws(() => registry.track(() => { spawned = true; return { kill: async () => true }; }), (err) => err.reason === "spawn-failed");
  assert.equal(spawned, false);
});

test("stopAll kills the process spawnChild started, and spawnChild refuses once it ran", async () => {
  const registry = createChildRegistry();
  const tracked = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { shell: false }, { stdio: "ignore" }, registry);
  await new Promise((r) => tracked.child.once("spawn", r));
  assert.ok(alive(tracked.child.pid));
  await registry.stopAll();
  assert.equal(isChildAlive(tracked.child), false);
  assert.throws(
    () => spawnChild(process.execPath, ["-e", ""], { shell: false }, { stdio: "ignore" }, registry),
    (err) => err.reason === "spawn-failed",
  );
});
