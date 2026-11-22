import process from "node:process";
import { execFile } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// POSIX only: a process group leader (setsid) lets treeKill reach the agent's children. On win32
// it would mean a new console, and taskkill /T walks the tree anyway. Applied at each spawn site,
// not in resolveAcpSpawn, so an injected spec gets it too.
export const DETACHED = process.platform !== "win32";

// On win32 child.kill() reaches only the wrapper; taskkill /T takes the whole tree.
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    // taskkill /T follows parent links, which an exited leader no longer has, and a reaped pid can
    // already belong to another process: after the exit there is nothing safe to kill.
    if (!childAlive) return;
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    }));
    return;
  }
  // The negative pid signals the whole group, which outlives its leader, so this runs even after
  // the child exited: its descendants may still be running.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  // Reaches a child that is not a group leader, where the group kill raised ESRCH. Skipped once
  // the child is gone, since a reaped pid can already belong to something else.
  if (childAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
