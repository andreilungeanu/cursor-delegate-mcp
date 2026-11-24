import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { spawnArgv } from "./spawn.js";
import { makeError } from "./errors.js";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// POSIX only: detached makes the child a process group leader, so treeKill reaches its children.
// On win32 it would open a separate console, and taskkill /T walks the tree.
export const DETACHED = process.platform !== "win32";

// How long taskkill may run, and then how long a stop waits for the exit.
export const KILL_WAIT_MS = 5000;

// Every process below pid, from one ps snapshot. Empty when ps fails: the group kill still runs.
function descendantPids(pid) {
  return /** @type {Promise<number[]>} */ (new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      /** @type {Map<number, number[]>} */
      const byParent = new Map();
      for (const line of String(stdout).split("\n")) {
        const [p, pp] = line.trim().split(/\s+/).map(Number);
        if (!p || !Number.isFinite(pp)) continue;
        if (!byParent.has(pp)) byParent.set(pp, []);
        byParent.get(pp)?.push(p);
      }
      const out = [];
      const queue = [pid];
      while (queue.length) {
        for (const c of byParent.get(queue.shift()) ?? []) {
          if (!out.includes(c)) { out.push(c); queue.push(c); }
        }
      }
      resolve(out);
    });
  }));
}

// On win32 a plain kill reaches only the launcher; taskkill /T takes the tree. False when taskkill
// failed or stalled. Its 128 is a process that ended before taskkill reached it: the launcher, or a
// short-lived command during the walk (measured).
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return true;
  if (process.platform === "win32") {
    // An exited leader has no tree left for taskkill to walk, and its pid may be reused.
    if (!childAlive) return true;
    return /** @type {Promise<boolean>} */ (new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: KILL_WAIT_MS, killSignal: "SIGKILL" }, (err) => resolve(!err || err.code === 128));
    }));
  }
  // Commands in a session of their own are outside the group: walked while the child is alive to
  // hold their parent links.
  const descendants = childAlive ? await descendantPids(pid) : [];
  // The group, even after the leader exited: members can outlive it.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  for (const d of descendants) {
    try { process.kill(-d, "SIGKILL"); } catch {}
    try { process.kill(d, "SIGKILL"); } catch {}
  }
  // A child that is not a group leader; skipped once reaped, as its pid may be reused.
  if (childAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }
  return true;
}

/** @type {WeakMap<object, Promise<boolean>>} */
const stops = new WeakMap();

/**
 * Kills child's tree, its own handle too when the tree kill fails, and waits for the exit within
 * KILL_WAIT_MS. True when the exit was seen and the tree kill succeeded. Once per child: every later
 * call gets the same promise.
 * @param {any} child
 * @returns {Promise<boolean>}
 */
export function stopChild(child) {
  let stop = stops.get(child);
  if (!stop) {
    stop = killAndWait(child);
    stops.set(child, stop);
  }
  return stop;
}

async function killAndWait(child) {
  if (!child.pid) return true;
  const alive = isChildAlive(child);
  // Subscribed before the kill, so an immediate exit is not missed.
  const exited = alive ? new Promise((resolve) => child.once("exit", () => resolve(true))) : Promise.resolve(true);
  const tidy = await treeKill(child.pid, { childAlive: alive }).catch(() => false);
  if (!tidy && isChildAlive(child)) { try { child.kill("SIGKILL"); } catch {} }
  return (await withDeadline(exited, KILL_WAIT_MS, false)) && tidy;
}

/**
 * promise's value, or fallback once ms have passed.
 * @template T @param {Promise<T>} promise @param {number} ms @param {T} fallback @returns {Promise<T>}
 */
export function withDeadline(promise, ms, fallback) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** @typedef {ReturnType<typeof createChildRegistry>} ChildRegistry */

// The processes shutdown stops. A child leaves when it exits, as its pid may then be reused.
export function createChildRegistry() {
  /** @type {Set<any>} */
  const live = new Set();
  let closed = false;
  return {
    /** @param {() => any} start a spawned child, or null */
    track(start) {
      if (closed) throw makeError("spawn-failed", "the server is shutting down, so no process was started");
      const child = start();
      if (!child) return null;
      live.add(child);
      child.once("exit", () => live.delete(child));
      return child;
    },
    stopAll() {
      closed = true;
      return Promise.all([...live].map(stopChild)).then(() => undefined);
    },
  };
}

export const children = createChildRegistry();

/**
 * The one place a process starts, so shutdown reaches every one. Throws spawn-failed once shutdown
 * began, before spawning.
 * @param {string} command @param {string[]} args @param {any} options
 * @param {{ stdio: any }} where
 * @param {ChildRegistry} [registry]
 */
export function spawnChild(command, args, options, { stdio }, registry = children) {
  return registry.track(() => {
    const argv = spawnArgv(command, args, options);
    return spawn(argv.command, argv.args, { ...argv.options, detached: DETACHED, stdio });
  });
}
