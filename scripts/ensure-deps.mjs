// Install runtime dependencies on SessionStart when the plugin cache has none.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (existsSync(join(root, "node_modules"))) {
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
  });
} catch (err) {
  console.error(`cursor-delegate-mcp: dependency install failed: ${err?.message || err}`);
  process.exit(1);
}
