import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

function readVersion() {
  return JSON.parse(readFileSync(PKG_PATH, "utf8")).version;
}

// Captured once, for the ACP/MCP identity handshake that is sent at connect and never re-read.
export const VERSION = readVersion();

// doctor reads fresh rather than using the constant: the MCP child is long-lived and
// /reload-plugins does not restart it, so a version captured at process start goes stale after
// an in-place upgrade — exactly when doctor is run to confirm the new version shipped. An
// un-restarted child running old code stays a gap, but no in-process value can close that.
export function readPackageVersion() {
  try {
    return readVersion();
  } catch {
    return VERSION;
  }
}
