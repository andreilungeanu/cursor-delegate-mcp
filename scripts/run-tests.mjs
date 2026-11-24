// Resolves the test file list here because no positional form of `node --test` works
// across the supported range: Node 20 cannot expand globs, Node 22 does not accept a
// directory, and neither cmd.exe nor PowerShell expands `test/*.test.js` for npm.
// Extra node flags (e.g. --experimental-test-coverage) pass straight through, and test
// files named after them (`npm test -- test/proc.test.js`) run in place of the full list.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = process.argv.slice(2);
const named = args.some((arg) => arg.endsWith(".test.js"));
const testDir = fileURLToPath(new URL("../test/", import.meta.url));
const files = named
  ? []
  : readdirSync(testDir)
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => testDir + name);

if (!named && files.length === 0) {
  console.error(`no *.test.js files found in ${testDir}`);
  process.exit(1);
}

const { status, signal } = spawnSync(process.execPath, ["--test", ...args, ...files], { stdio: "inherit" });
process.exit(signal ? 1 : status ?? 1);
