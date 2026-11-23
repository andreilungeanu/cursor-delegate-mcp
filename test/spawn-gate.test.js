import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "src/proc.js";

// Every way in names the module in a string literal.
const REACHES_CHILD_PROCESS = /(["'`])(?:node:)?child_process\1/;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.[cm]?js$/.test(entry.name) ? [path] : [];
  });
}

test("the gate sees every way a module can reach child_process", () => {
  for (const source of [
    `import { spawn } from "node:child_process";`,
    `import cp from 'child_process';`,
    "export { spawn } from `child_process`;",
    `const cp = await import("node:child_process");`,
    `const cp = require("child_process");`,
    `const load = createRequire(import.meta.url); const cp = load("node:child_process");`,
  ]) assert.match(source, REACHES_CHILD_PROCESS);
});

test("only src/proc.js reaches child_process", () => {
  const offenders = sources(join(ROOT, "src"))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    .filter((file) => file !== OWNER && REACHES_CHILD_PROCESS.test(readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(offenders, [], offenders.map((file) => `${file} reaches node:child_process. Start processes with spawnChild from ${OWNER}, so shutdown can reach them.`).join("\n"));
});
