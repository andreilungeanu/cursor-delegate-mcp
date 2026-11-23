import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "src/errors.js";

// A write, not a comparison or an arrow: `=` not followed by `=` or `>`.
const WRITES_ERROR_FIELD = /(?:\.(?:message|reason|code|cause|stack)|\[\s*["'`](?:message|reason|code|cause|stack)["'`]\s*\])\s*(?:\+=|\?\?=|\|\|=|&&=|=(?![=>]))|Object\.(?:assign|defineProperty)\(\s*(?:err|error|e|cause|failed)\b/;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.[cm]?js$/.test(entry.name) ? [path] : [];
  });
}

test("the check sees each way to write onto an error, and not a read or a comparison", () => {
  for (const line of [
    "err.message += note;",
    "{ try { err.reason = reason; } catch {} }",
    "err.code = msg.error.code;",
    "Object.assign(err, { reason });",
    "err.reason ??= \"agent-error\";",
    "err[\"message\"] = text;",
  ]) assert.match(line, WRITES_ERROR_FIELD);
  for (const line of ["if (err.code === -32000) {", "const isTimeout = err?.reason === \"hard-cap\";", "(e) => e.code", "const text = err[\"message\"];"]) {
    assert.doesNotMatch(line, WRITES_ERROR_FIELD);
  }
});

test("only src/errors.js writes the fields of an error", () => {
  const offenders = sources(join(ROOT, "src"))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    .filter((file) => file !== OWNER)
    .flatMap((file) => readFileSync(join(ROOT, file), "utf8").split("\n")
      .map((line, i) => ({ at: `${file}:${i + 1}`, line: line.trim() }))
      .filter(({ line }) => !line.startsWith("//") && WRITES_ERROR_FIELD.test(line)));
  assert.deepEqual(offenders, [], offenders.map(({ at, line }) => `${at} writes onto an error: ${line}\n  A caught error may be frozen or a primitive. Build a new one with makeError(reason, message, { code, cause }) from ${OWNER}.`).join("\n"));
});
