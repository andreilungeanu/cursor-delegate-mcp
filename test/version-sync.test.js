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
  const registry = read("../server.json");

  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  for (const manifest of manifests) assert.equal(manifest.version, pkg.version);
  assert.equal(copilotMarketplace.metadata.version, pkg.version);
  assert.equal(copilotMarketplace.plugins[0].version, pkg.version);
  assert.equal(registry.version, pkg.version);
  assert.equal(registry.packages[0].version, pkg.version);

  const pin = `cursor-delegate-mcp@${pkg.version}`;
  for (const path of ["../.mcp.copilot.json"]) {
    assert.ok(JSON.stringify(read(path)).includes(pin), `${path} must pin ${pin}`);
  }
  assert.ok(JSON.stringify(manifests[1].mcpServers).includes(pin), "Codex inline MCP config must pin the package version");

  // The Codex marketplace clones this ref for the skill while the manifest above pins the server
  // to a published version. On `main` the two describe different builds, so the ref moves with
  // the release like every other pin here.
  const agents = read("../.agents/plugins/marketplace.json");
  assert.equal(agents.plugins[0].source.ref, `v${pkg.version}`);
});

test("registry ownership metadata matches the published package", () => {
  const pkg = read("../package.json");
  const registry = read("../server.json");

  // The registry verifies ownership by matching mcpName inside the published npm
  // package against the name in server.json. A mismatch fails the publish.
  assert.equal(registry.name, pkg.mcpName);
  assert.equal(registry.packages[0].identifier, pkg.name);
  assert.equal(registry.packages[0].registryType, "npm");
});
