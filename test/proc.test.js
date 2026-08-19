import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { isChildAlive, treeKill } from "../src/proc.js";

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
