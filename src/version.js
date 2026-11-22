import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

function readVersion() {
  return JSON.parse(readFileSync(PKG_PATH, "utf8")).version;
}

// Captured once, for the ACP/MCP identity handshake that is sent at connect and never re-read.
export const VERSION = readVersion();

// Read fresh for doctor: /reload-plugins does not restart the server, so the constant goes stale
// after an in-place upgrade, just when doctor confirms it. The running code stays old until a restart.
export function readPackageVersion() {
  try {
    return readVersion();
  } catch {
    return VERSION;
  }
}
