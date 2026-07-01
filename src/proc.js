import process from "node:process";
import { execFile } from "node:child_process";

export function isChildAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

// On win32 a plain child.kill() only reaches the shell wrapper (spawn uses shell: true);
// taskkill /T takes the whole tree so the agent itself dies too.
export async function treeKill(pid) {
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}
