import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

test("package and plugin manifest versions stay in sync", () => {
  const pkg = read("../package.json");
  const lock = read("../package-lock.json");
  const manifests = [
    read("../.claude-plugin/plugin.json"),
    read("../.codex-plugin/plugin.json"),
    read("../plugin.json"),
  ];
  const copilotMarketplace = read("../.github/plugin/marketplace.json");

  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  for (const manifest of manifests) assert.equal(manifest.version, pkg.version);
  assert.equal(copilotMarketplace.metadata.version, pkg.version);
  assert.equal(copilotMarketplace.plugins[0].version, pkg.version);

  const pin = `cursor-delegate-mcp@${pkg.version}`;
  for (const path of ["../.mcp.copilot.json"]) {
    assert.ok(JSON.stringify(read(path)).includes(pin), `${path} must pin ${pin}`);
  }
  assert.ok(JSON.stringify(manifests[1].mcpServers).includes(pin), "Codex inline MCP config must pin the package version");
});
