import process from "node:process";
import { execFile } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// POSIX only: detached makes the child a process group leader (setsid), which is what lets
// treeKill reach the agent's own children. On win32 it would mean a separate console instead,
// and taskkill /T already walks the tree. Every spawn site applies it, not resolveAcpSpawn —
// an injected spawnSpec has to become a group leader too or the group kill finds nothing.
export const DETACHED = process.platform !== "win32";

// On win32 a plain child.kill() only reaches the shell wrapper (spawn uses shell: true);
// taskkill /T takes the whole tree so the agent itself dies too.
export async function treeKill(pid, { childAlive = true } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    // taskkill /T walks parent links, which an exited leader no longer has: what it started is
    // either gone with it or detached and out of reach. So a post-exit kill has nothing left to
    // reach, and a reaped pid can already belong to somebody else — which makes the gate the
    // whole of it here, where POSIX still has the group to aim at.
    if (!childAlive) return;
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    }));
    return;
  }
  // Negative pid signals the whole group, so the agent's descendants go with it. A group outlives
  // its leader while any member is left, which is why this runs even for an exited child: that is
  // the case where descendants are the only thing still running.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  // Reaches a child that is not a group leader, where the group kill raised ESRCH. Skipped once
  // the child is gone, since a reaped pid can already belong to something else.
  if (childAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
