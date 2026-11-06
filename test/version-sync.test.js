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
  assert.ok(JSON.stringify(read("../.mcp.copilot.json")).includes(pin), `../.mcp.copilot.json must pin ${pin}`);
  assert.equal(manifests[1].mcpServers, "./.mcp.json");
  const codexMcp = read("../.mcp.json");
  assert.equal(codexMcp.mcpServers["cursor-delegate"].command, "node");
  assert.ok(codexMcp.mcpServers["cursor-delegate"].args.includes("./src/server.js"));

  const iconTag = `/v${pkg.version}/assets/`;
  for (const icon of registry.icons) {
    assert.match(icon.src, new RegExp(`^https://raw\\.githubusercontent\\.com/andreilungeanu/cursor-delegate-mcp${iconTag}`));
    assert.ok(icon.src.length <= 255, "registry Icon.src maxLength is 255");
  }
  assert.deepEqual(
    registry.icons.map((icon) => icon.theme),
    ["light", "dark"]
  );

  // Fork development follows main so an unpublished candidate plugin can be installed directly.
  const agents = read("../.agents/plugins/marketplace.json");
  assert.equal(agents.plugins[0].source.ref, "main");
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
