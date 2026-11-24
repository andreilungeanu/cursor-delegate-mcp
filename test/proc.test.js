import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { KILL_WAIT_MS, createChildRegistry, isChildAlive, spawnChild, stopChild, treeKill } from "../src/proc.js";

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

// agy and Codex run each shell command in a session of its own, which the group kill misses
// (measured on Linux). A fake agent leads its group and starts a grandchild in a new session.
test("treeKill reaches a descendant the agent started in its own session", posixOnly, async () => {
  const agentSrc = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });",
    "console.log(g.pid);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const agent = spawn(process.execPath, ["-e", agentSrc], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise((resolve) => agent.stdout.once("data", (d) => resolve(String(d).trim()))));
  assert.ok(alive(grandchild), "the grandchild must be running before the kill");
  try {
    await treeKill(agent.pid, { childAlive: true });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(alive(grandchild), false, "the grandchild in its own session survived the kill");
  } finally {
    try { process.kill(grandchild, "SIGKILL"); } catch {}
    try { process.kill(-agent.pid, "SIGKILL"); } catch {}
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

const startChild = (registry = createChildRegistry()) => spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { shell: false }, { stdio: "ignore" }, registry);

test("stopChild kills a running child once, and every caller gets that stop", async () => {
  const child = startChild();
  await new Promise((r) => child.once("spawn", r));
  const first = stopChild(child);
  assert.equal(stopChild(child), first);
  assert.equal(await first, true);
  assert.equal(isChildAlive(child), false);
});

// The launcher dies by its handle, but what it started is out of reach: the stop stays unconfirmed,
// so the caller still warns that it may be running.
test("a taskkill that fails still ends the launcher, by its own handle, and the stop is unconfirmed", win32Only, async () => {
  const swap = swapTaskkill("process.exit(1)");
  const child = startChild();
  try {
    assert.equal(await stopChild(child), false, "a failed taskkill was taken for a clean stop");
    assert.equal(isChildAlive(child), false, "the launcher outlived the stop");
  } finally {
    swap.restore();
    try { child.kill("SIGKILL"); } catch {}
  }
});

test("a taskkill that stalls is stopped at its bound, and the launcher killed by its own handle", win32Only, async () => {
  const swap = swapTaskkill("setInterval(() => {}, 1000)");
  const child = startChild();
  const started = Date.now();
  try {
    assert.equal(await stopChild(child), false, "a stalled taskkill was taken for a clean stop");
    assert.equal(isChildAlive(child), false, "the launcher outlived the stop");
    assert.ok(Date.now() - started < KILL_WAIT_MS + 2000, `the stop took ${Date.now() - started} ms`);
    assert.notEqual(swap.utilities[0].signalCode ?? swap.utilities[0].exitCode, null, "the stalled taskkill is still running");
  } finally {
    swap.restore();
    try { child.kill("SIGKILL"); } catch {}
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

test("stopAll kills the process spawnChild started, and spawnChild refuses once it ran", async () => {
  const registry = createChildRegistry();
  const child = startChild(registry);
  await new Promise((r) => child.once("spawn", r));
  assert.ok(alive(child.pid));
  await registry.stopAll();
  assert.equal(isChildAlive(child), false);
  assert.throws(
    () => spawnChild(process.execPath, ["-e", ""], { shell: false }, { stdio: "ignore" }, registry),
    (err) => err.reason === "spawn-failed",
  );
});
