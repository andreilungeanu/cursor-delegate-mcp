import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { normalizeAgentReportedFiles } from "../src/agent-reported-files.js";

const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";
const abs = (p) => path.resolve(ROOT, p);

test("dedupes repeated diff events for the same path", () => {
  const out = normalizeAgentReportedFiles([abs("a.txt"), "a.txt", abs("a.txt")], ROOT);
  assert.deepEqual(out, ["a.txt"]);
});

test("relativizes both relative and absolute inputs against the workspace", () => {
  const out = normalizeAgentReportedFiles(["src/a.js", abs("src/b.js")], ROOT);
  assert.deepEqual(out, ["src/a.js", "src/b.js"]);
});

test("paths outside the workspace stay absolute", () => {
  const outside = path.resolve(ROOT, "..", "elsewhere", "x.txt");
  const out = normalizeAgentReportedFiles([outside], ROOT);
  assert.deepEqual(out, [outside]);
});

test("uses forward slashes for workspace-relative paths", () => {
  const out = normalizeAgentReportedFiles([abs(path.join("deep", "nested", "f.txt"))], ROOT);
  assert.deepEqual(out, ["deep/nested/f.txt"]);
});

test("empty input returns an empty array", () => {
  assert.deepEqual(normalizeAgentReportedFiles([], ROOT), []);
});

test("without a workspace, paths resolve against cwd and stay absolute", () => {
  const out = normalizeAgentReportedFiles(["a.txt"], undefined);
  assert.deepEqual(out, [path.resolve("a.txt")]);
});
