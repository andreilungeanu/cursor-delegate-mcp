import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
const pkg = read("package.json");
const pin = `cursor-delegate-mcp@${pkg.version}`;

test("Codex plugin manifest references real portable components", () => {
  const manifestPath = resolve(ROOT, ".codex-plugin/plugin.json");
  const manifest = read(".codex-plugin/plugin.json");
  assert.equal(manifest.name, "cursor-delegate-mcp");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  for (const field of ["skills"]) {
    assert.match(manifest[field], /^\.\//);
    assert.ok(existsSync(resolve(dirname(manifestPath), "..", manifest[field])), `${field} path must exist`);
  }
  assert.equal(manifest.mcpServers["cursor-delegate-mcp"].command, "npx");
  assert.deepEqual(manifest.mcpServers["cursor-delegate-mcp"].args, ["-y", pin]);
  for (const field of ["composerIcon", "logo"]) {
    const target = resolve(dirname(manifestPath), "..", manifest.interface[field]);
    assert.ok(existsSync(target), `${field} asset must exist`);
    assert.deepEqual([...readFileSync(target).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.deepEqual(manifest.interface.capabilities, ["Read", "Write"]);
});

test("marketplaces and Copilot plugin point at the intended package", () => {
  const codexMarketplace = read(".agents/plugins/marketplace.json");
  const codexEntry = codexMarketplace.plugins[0];
  assert.equal(codexEntry.name, "cursor-delegate-mcp");
  assert.equal(codexEntry.source.source, "url");
  assert.match(codexEntry.source.url, /^https:\/\/github\.com\/andreilungeanu\//);
  assert.equal(codexEntry.policy.installation, "AVAILABLE");
  assert.equal(codexEntry.policy.authentication, "ON_INSTALL");

  const copilot = read("plugin.json");
  assert.ok(existsSync(resolve(ROOT, copilot.skills)));
  assert.ok(existsSync(resolve(ROOT, copilot.mcpServers)));
  const copilotMcp = read(".mcp.copilot.json");
  assert.deepEqual(copilotMcp["cursor-delegate-mcp"].args, ["-y", pin]);

  const copilotMarketplace = read(".github/plugin/marketplace.json");
  assert.equal(copilotMarketplace.plugins[0].source, "./");
});

test("Claude plugin launches bundled code and bootstraps its runtime dependencies", () => {
  const manifest = read(".claude-plugin/plugin.json");
  assert.equal(manifest.mcpServers, "./.claude-plugin/mcp.json");
  assert.equal(manifest.hooks, "./.claude-plugin/hooks.json");

  const claudeMcp = read(".claude-plugin/mcp.json");
  const server = claudeMcp.mcpServers["cursor-delegate-mcp"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/server.js"]);

  const hooks = read(".claude-plugin/hooks.json");
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /\.claude-plugin\/ensure-deps\.mjs/);
  assert.ok(existsSync(resolve(ROOT, ".claude-plugin/ensure-deps.mjs")));
});

// Copilot CLI reads a root .mcp.json regardless of the manifest, and Codex
// auto-discovers hooks/hooks.json even when the Codex manifest omits hooks.
// Claude-only config must therefore never live at those conventional paths.
test("no Claude-only config at paths other hosts auto-discover", () => {
  assert.ok(!existsSync(resolve(ROOT, ".mcp.json")), ".mcp.json at the repo root leaks into Copilot installs");
  assert.ok(!existsSync(resolve(ROOT, "hooks/hooks.json")), "hooks/hooks.json is auto-discovered by Codex");
});
