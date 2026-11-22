// Install runtime dependencies on SessionStart when the plugin cache has none.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Each declared dependency's package.json, not its directory: an interrupted unpack leaves the
// directory present and empty.
let complete = false;
try {
  const { dependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  complete = Object.keys(dependencies || {}).every((name) =>
    existsSync(join(root, "node_modules", name, "package.json"))
  );
} catch {
  // An unreadable manifest: install, and let npm report.
}
if (complete) {
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    // npm's stdout to stderr: Claude Code adds a SessionStart hook's stdout to the session context.
    stdio: ["ignore", 2, "inherit"],
    // npm.cmd is a batch file, which Node spawns only through a shell (EINVAL otherwise). The
    // arguments are fixed, so the shell carries no caller input.
    shell: process.platform === "win32",
  });
} catch (err) {
  console.error(`cursor-delegate-mcp: dependency install failed: ${err?.message || err}`);
  process.exit(1);
}
