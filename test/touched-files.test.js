import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parsePorcelain, computeTouched, gitChangedSet } from "../src/touched-files.js";

const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";
const abs = (p) => path.resolve(ROOT, p);

test("parsePorcelain handles modified, untracked, deleted, and renamed entries", () => {
  const out = [
    " M src/a.js",
    "?? new.txt",
    " D gone.txt",
    "R  old.txt -> renamed.txt",
  ].join("\n");
  const set = parsePorcelain(out, ROOT);
  assert.ok(set.has(abs("src/a.js")));
  assert.ok(set.has(abs("new.txt")));
  assert.ok(set.has(abs("gone.txt")));
  assert.ok(set.has(abs("renamed.txt")), "rename should record the destination");
  assert.ok(!set.has(abs("old.txt")), "rename should not record the source");
});

test("parsePorcelain ignores blank lines and tolerates empty input", () => {
  assert.equal(parsePorcelain("", ROOT).size, 0);
  assert.equal(parsePorcelain("\n\n", ROOT).size, 0);
});

test("computeTouched without git falls back to diff-scraped set (diff-only)", () => {
  const r = computeTouched({ before: null, after: null, diffTouched: [abs("a.txt"), abs("a.txt")], workspace: ROOT });
  assert.deepEqual(r.files, ["a.txt"]);
  assert.equal(r.source, "diff-only");
});

test("computeTouched with git returns (after - before) and excludes transient files", () => {
  const before = new Set([abs("preexisting.txt")]);
  const after = new Set([abs("preexisting.txt"), abs("renamed.txt")]);
  // hello.txt was created then renamed away -> diff-scraped but not in `after` -> dropped.
  const r = computeTouched({ before, after, diffTouched: [abs("hello.txt")], workspace: ROOT });
  assert.deepEqual(r.files, ["renamed.txt"]);
  assert.equal(r.source, "git");
});

test("computeTouched recovers edits to already-dirty files via the diff intersection", () => {
  // already-dirty.txt is dirty before AND after, so it falls out of the delta;
  // the diff-scraped intersection with `after` recovers it.
  const before = new Set([abs("already-dirty.txt")]);
  const after = new Set([abs("already-dirty.txt")]);
  const r = computeTouched({ before, after, diffTouched: [abs("already-dirty.txt")], workspace: ROOT });
  assert.deepEqual(r.files, ["already-dirty.txt"]);
  assert.equal(r.source, "git");
});

test("gitChangedSet returns null when the git command throws (not a repo / no git)", () => {
  const throwingRun = () => { throw new Error("not a git repository"); };
  assert.equal(gitChangedSet("/nope", throwingRun), null);
  assert.equal(gitChangedSet(undefined, throwingRun), null);
});

test("gitChangedSet parses output via the injected runner", () => {
  const run = (cmd, args) => {
    if (args.includes("rev-parse")) return ROOT + "\n";
    return " M src/a.js\n?? b.txt\n";
  };
  const set = gitChangedSet(ROOT, run);
  assert.ok(set.has(abs("src/a.js")));
  assert.ok(set.has(abs("b.txt")));
});
