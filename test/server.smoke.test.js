import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("../src/server.js", import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

// The bin is a stdio server, so an unrecognised flag starts the transport and waits on stdin.
// The version has to come back without a host attached, and it has to be the version of this
// code rather than whatever a manifest pinned.
test("the binary answers --version and exits without starting the transport", async () => {
  // -v too: it is what a hand check reaches for, and falling through to the transport there
  // reads exactly like the wedged install the flag exists to rule out.
  for (const flag of ["--version", "-v"]) {
    const { stdout } = await run(process.execPath, [ENTRY, flag], { timeout: 10000 });
    assert.equal(stdout.trim(), PKG.version, `${flag} must print the version`);
  }
});
