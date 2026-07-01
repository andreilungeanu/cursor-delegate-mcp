import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

test("package.json and .claude-plugin/plugin.json versions stay in sync", () => {
  const pkg = read("../package.json");
  const plugin = read("../.claude-plugin/plugin.json");
  assert.equal(plugin.version, pkg.version, "bump both package.json and .claude-plugin/plugin.json");
});
