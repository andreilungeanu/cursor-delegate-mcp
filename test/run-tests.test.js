import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
// A runner that ignored the named files would run this suite again, this file included.
const nested = { skip: process.env.RUN_TESTS_NESTED ? "inside a runner test" : false };
// NODE_TEST_CONTEXT, set for this file, would make the nested run report as a child of this one.
const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
const runRunner = (args, env = {}, timeout = 60000) => spawnSync(process.execPath, [RUNNER, ...args], {
  encoding: "utf8", timeout, env: { ...parentEnv, RUN_TESTS_NESTED: "1", ...env },
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("named test files run in place of the full list", nested, () => {
  const run = runRunner([fixture("passes.test-fixture.mjs")]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# tests 1$/m);
});

test("a run still going at its deadline is stopped with its processes, and fails", nested, async () => {
  const pidFile = join(tmpdir(), `run-tests-leak-${process.pid}-${Date.now()}`);
  const started = Date.now();
  const run = runRunner([fixture("leaks-a-process.test-fixture.mjs")], { TEST_RUN_DEADLINE_MS: "3000", LEAK_PID_FILE: pidFile }, 30000);
  let leaked;
  try {
    leaked = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Date.now() - started < 25000, `the run took ${Date.now() - started} ms`);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /still going after 3000 ms/);
    const deadline = Date.now() + 5000;
    while (alive(leaked) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(leaked), false, "the leaked process outlived the run");
  } finally {
    if (leaked && alive(leaked)) { try { process.kill(leaked, "SIGKILL"); } catch {} }
    rmSync(pidFile, { force: true });
  }
});
