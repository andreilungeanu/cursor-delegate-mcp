// Install runtime dependencies on SessionStart when the plugin cache has none.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Every declared dependency, and the package.json inside each rather than the directory holding
// it: npm extracts into that directory, so an interrupted unpack leaves it present and empty.
// Keying off a bare node_modules then skipped the repair on every later session while the server
// went on failing to import. Reading the list covers a dependency added later for free.
let complete = false;
try {
  const { dependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  complete = Object.keys(dependencies || {}).every((name) =>
    existsSync(join(root, "node_modules", name, "package.json"))
  );
} catch {
  // An unreadable manifest is no reason to trust the tree. Install, and let npm report.
}
if (complete) {
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
    // npm.cmd is a batch file, and Node refuses to spawn one without a shell — so the first
    // session after a plugin install failed on Windows with `spawnSync npm.cmd EINVAL`, before
    // doctor existed to report it. The argument list is fixed and carries no caller input, so
    // the injection rule that keeps shell off elsewhere has nothing to bite on here.
    shell: process.platform === "win32",
  });
} catch (err) {
  console.error(`cursor-delegate-mcp: dependency install failed: ${err?.message || err}`);
  process.exit(1);
}
