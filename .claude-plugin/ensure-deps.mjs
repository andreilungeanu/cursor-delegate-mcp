// Install runtime dependencies on SessionStart when the plugin cache has none.
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const modulePath = fileURLToPath(import.meta.url);
const root = dirname(dirname(modulePath));

export async function ensureRuntimeDependencies() {
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
  if (complete) return;

  try {
    if (process.platform === "win32") {
      execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "& npm install --omit=dev --no-audit --no-fund; exit $LASTEXITCODE",
      ], {
        cwd: root,
        // npm's stdout must never enter the MCP protocol stream.
        stdio: ["ignore", "ignore", "inherit"],
      });
    } else {
      execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: root,
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
  } catch (err) {
    const error = /** @type {Error & { reason?: string }} */ (err);
    error.reason = "dependency-install-failed";
    error.message = `cursor-delegate-mcp dependency install failed: ${error.message}`;
    throw error;
  }
}

let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {}
}

if (isMain) {
  ensureRuntimeDependencies().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
