// A test file for the runner's tests: its test passes and leaves a process running, which holds the
// file open as a missed kill would. The process's pid goes to LEAK_PID_FILE.
import { test } from "node:test";
import process from "node:process";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

test("the fixture leaks a process", () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.LEAK_PID_FILE, String(child.pid));
});
