import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
// A runner that ignored the named files would run this suite again, this file included.
const nested = { skip: process.env.RUN_TESTS_NESTED ? "inside a runner test" : false };
// NODE_TEST_CONTEXT, set for this file, would make the nested run report as a child of this one.
const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
const runRunner = (args, env = {}) => spawnSync(process.execPath, [RUNNER, ...args], {
  encoding: "utf8", timeout: 60000, env: { ...parentEnv, RUN_TESTS_NESTED: "1", ...env },
});

test("named test files run in place of the full list", nested, () => {
  const run = runRunner([fixture("passes.test-fixture.mjs")]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# tests 1$/m);
});
