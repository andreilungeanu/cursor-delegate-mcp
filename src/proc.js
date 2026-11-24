import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { spawnArgv } from "./spawn.js";
import { makeError } from "./errors.js";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// POSIX only: a process group leader (setsid) lets treeKill reach the agent's children. On win32
// it would mean a new console, and taskkill /T walks the tree anyway. Applied in spawnChild, not
// in resolveAcpSpawn, so an injected spec gets it too.
export const DETACHED = process.platform !== "win32";

// On win32 child.kill() reaches only the wrapper; taskkill /T takes the whole tree. False when
// taskkill failed or stalled; its 128 is no such process, a launcher already gone.
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return true;
  if (process.platform === "win32") {
    // taskkill /T follows parent links, which an exited leader no longer has, and a reaped pid can
    // already belong to another process: after the exit there is nothing safe to kill.
    if (!childAlive) return true;
    return /** @type {Promise<boolean>} */ (new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: TASKKILL_MS, killSignal: "SIGKILL" }, (err) => resolve(!err || err.code === 128));
    }));
  }
  // The negative pid signals the whole group, which outlives its leader, so this runs even after
  // the child exited: its descendants may still be running.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  // Reaches a child that is not a group leader, where the group kill raised ESRCH. Skipped once
  // the child is gone, since a reaped pid can already belong to something else.
  if (childAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }
  return true;
}

// How long one kill attempt waits for the exit and the tree kill. SIGKILL and taskkill /F land in
// milliseconds, so this elapses only when the kill failed.
export const KILL_WAIT_MS = 2000;
// A taskkill still running by then is stopped, and the launcher killed by its handle instead.
const TASKKILL_MS = KILL_WAIT_MS;

async function killAndSeeExit(child, timeoutMs) {
  if (!child.pid) return true;
  const alive = isChildAlive(child);
  // Subscribed before the kill, so an instant exit is not missed.
  const exited = alive
    ? /** @type {Promise<boolean>} */ (new Promise((resolve) => child.once("exit", () => resolve(true))))
    : Promise.resolve(true);
  // Runs for an exited child too: on POSIX the commands it spawned stay in its process group. One
  // tree kill at a time: a retry joins the one still running.
  let killed = treeKills.get(child);
  if (!killed) {
    killed = treeKill(child.pid, { childAlive: alive }).catch(() => false).then((tidy) => {
      if (tidy) return;
      // The launcher's own handle still kills it, and no reused pid, but what it started may run on:
      // every later stop of this child reports the tree unconfirmed.
      unconfirmed.add(child);
      if (isChildAlive(child)) { try { child.kill("SIGKILL"); } catch {} }
    }).finally(() => treeKills.delete(child));
    treeKills.set(child, killed);
  }
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const bounded = /** @type {Promise<boolean>} */ (new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  }));
  const observed = await Promise.race([exited, bounded]);
  // On win32 taskkill can still be at work on the tree once the launcher's exit is seen.
  const treeKilled = await Promise.race([killed.then(() => true), bounded]);
  clearTimeout(timer);
  return observed && treeKilled && !unconfirmed.has(child);
}

/** @type {WeakMap<import("node:child_process").ChildProcess, Promise<unknown>>} */
const treeKills = new WeakMap();
// Children whose tree kill failed, so their exit does not show their processes ended.
/** @type {WeakSet<import("node:child_process").ChildProcess>} */
const unconfirmed = new WeakSet();

/**
 * @typedef {{
 *   child: any,
 *   stop: (opts?: { timeoutMs?: number }) => Promise<boolean>,
 *   release: () => void,
 * }} TrackedChild
 * @typedef {{ child?: any, kill: (timeoutMs: number) => Promise<boolean>, spent?: () => boolean }} ChildKill
 * @typedef {ReturnType<typeof createChildRegistry>} ChildRegistry
 */

// The processes still to stop. An entry leaves once a stop saw its exit and its tree kill ended, a
// stop failed with nothing left to reach, or its owner releases it; after that its pid may be reused.
export function createChildRegistry() {
  /** @type {Set<TrackedChild>} */
  const live = new Set();
  let closed = false;
  return {
    /**
     * @param {() => ChildKill} start
     * @returns {TrackedChild}
     */
    track(start) {
      if (closed) throw makeError("spawn-failed", "the server is shutting down, so no process was started");
      const kill = start();
      /** @type {Promise<boolean> | null} */
      let stopping = null;
      // What a stop reports once the entry has left.
      let outcome = true;
      const attempt = (timeoutMs) => {
        try { return Promise.resolve(kill.kill(timeoutMs)).catch(() => false); } catch { return Promise.resolve(false); }
      };
      /** @type {TrackedChild} */
      const entry = {
        child: kill.child,
        // An attempt that missed the exit is retried once; a later stop kills again.
        stop: ({ timeoutMs = KILL_WAIT_MS } = {}) => {
          if (!live.has(entry)) return Promise.resolve(outcome);
          stopping ??= attempt(timeoutMs).then((seen) => seen || attempt(timeoutMs)).then((seen) => {
            stopping = null;
            if (seen || kill.spent?.()) { live.delete(entry); outcome = seen; }
            return seen;
          });
          return stopping;
        },
        // For a child that closed by itself.
        release: () => { if (!stopping) live.delete(entry); },
      };
      live.add(entry);
      return entry;
    },
    // Each stop sends its kill as it starts, so on POSIX every kill is out before this returns.
    stopAll() {
      closed = true;
      return Promise.all([...live].map((entry) => entry.stop())).then(() => undefined);
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
    const child = spawn(argv.command, argv.args, { ...argv.options, detached: DETACHED, stdio });
    // A launcher gone after a failed tree kill: no later kill reaches what it started.
    return { child, kill: (timeoutMs) => killAndSeeExit(child, timeoutMs), spent: () => unconfirmed.has(child) && !isChildAlive(child) };
  });
}
