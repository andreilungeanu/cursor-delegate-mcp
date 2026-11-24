// Resolves the test file list here because no positional form of `node --test` works
// across the supported range: Node 20 cannot expand globs, Node 22 does not accept a
// directory, and neither cmd.exe nor PowerShell expands `test/*.test.js` for npm.
// Extra node flags (e.g. --experimental-test-coverage) pass straight through, and test
// files named after them (`npm test -- test/ops.test.js`) run in place of the full list.
import { readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = process.argv.slice(2);
// By extension, so a flag's separate value (`--test-name-pattern foo`) is not taken for a file.
const named = args.filter((arg) => !arg.startsWith("-") && /\.[cm]?js$/.test(arg));
const testDir = fileURLToPath(new URL("../test/", import.meta.url));
const files = named.length
  ? []
  : readdirSync(testDir)
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => testDir + name);

if (!named.length && files.length === 0) {
  console.error(`no *.test.js files found in ${testDir}`);
  process.exit(1);
}

// A test file held open by a process it leaked would keep the run going forever.
const deadlineMs = Number(process.env.TEST_RUN_DEADLINE_MS) || 20 * 60 * 1000;

const run = spawn(process.execPath, ["--test", ...args, ...files], { stdio: "inherit" });
const timer = setTimeout(() => {
  console.error(`\nthe test run was still going after ${deadlineMs} ms; stopping it and every process it started`);
  killTree(run.pid);
  process.exit(1);
}, deadlineMs);
run.on("exit", (code, signal) => {
  clearTimeout(timer);
  process.exit(signal ? 1 : code ?? 1);
});

function killTree(root) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(root), "/T", "/F"], { windowsHide: true, timeout: 10000 });
    return;
  }
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 10000 });
  const children = new Map();
  for (const line of (ps.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i]) ?? []));
  for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
