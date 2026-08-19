import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
const pkg = read("package.json");
const pin = `cursor-delegate-mcp@${pkg.version}`;
const pluginName = "cursor-delegate";
const serverName = "cursor-delegate";
const marketplaceName = "cursor-delegate-mcp";

test("Codex plugin manifest references real portable components", () => {
  const manifestPath = resolve(ROOT, ".codex-plugin/plugin.json");
  const manifest = read(".codex-plugin/plugin.json");
  assert.equal(manifest.name, pluginName);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  for (const field of ["skills"]) {
    assert.match(manifest[field], /^\.\//);
    assert.ok(existsSync(resolve(dirname(manifestPath), "..", manifest[field])), `${field} path must exist`);
  }
  assert.equal(manifest.mcpServers[serverName].command, "npx");
  assert.deepEqual(manifest.mcpServers[serverName].args, ["-y", pin]);
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
  const codexManifest = read(".codex-plugin/plugin.json");
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  const selector = `${codexEntry.name}@${codexMarketplace.name}`;
  assert.equal(codexMarketplace.name, marketplaceName);
  assert.equal(codexEntry.name, pluginName);
  assert.equal(codexEntry.name, codexManifest.name);
  assert.notEqual(codexEntry.name, codexMarketplace.name);
  assert.match(readme, new RegExp(`/plugin install ${selector}`));
  assert.match(readme, new RegExp(`codex plugin add ${selector}`));
  assert.equal(codexEntry.source.source, "url");
  assert.match(codexEntry.source.url, /^https:\/\/github\.com\/andreilungeanu\//);
  assert.equal(codexEntry.policy.installation, "AVAILABLE");
  assert.equal(codexEntry.policy.authentication, "ON_INSTALL");

  const copilot = read("plugin.json");
  assert.equal(copilot.name, pluginName);
  assert.ok(existsSync(resolve(ROOT, copilot.skills)));
  assert.ok(existsSync(resolve(ROOT, copilot.mcpServers)));
  const copilotMcp = read(".mcp.copilot.json");
  assert.deepEqual(copilotMcp[serverName].args, ["-y", pin]);

  const copilotMarketplace = read(".github/plugin/marketplace.json");
  assert.equal(copilotMarketplace.name, marketplaceName);
  assert.equal(copilotMarketplace.plugins[0].name, pluginName);
  assert.equal(copilotMarketplace.plugins[0].name, copilot.name);
  assert.equal(copilotMarketplace.plugins[0].source, "./");
});

test("Claude plugin launches bundled code and bootstraps its runtime dependencies", () => {
  const manifest = read(".claude-plugin/plugin.json");
  const marketplace = read(".claude-plugin/marketplace.json");
  assert.equal(manifest.name, pluginName);
  assert.equal(marketplace.name, marketplaceName);
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.notEqual(marketplace.plugins[0].name, marketplace.name);
  assert.equal(manifest.mcpServers, "./.claude-plugin/mcp.json");
  assert.equal(manifest.hooks, "./.claude-plugin/hooks.json");

  const claudeMcp = read(".claude-plugin/mcp.json");
  const server = claudeMcp.mcpServers[serverName];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/server.js"]);

  const listed = new Set(marketplace.plugins.map((entry) => entry.name));
  for (const [from, to] of Object.entries(marketplace.renames)) {
    assert.ok(!listed.has(from), `renamed-from ${from} must not still be a plugin entry`);
    assert.ok(to === null || listed.has(to), `rename ${from} must terminate at null or a listed plugin`);
  }
  assert.equal(marketplace.renames["cursor-delegate-mcp"], pluginName);

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

// The bootstrap hook, run rather than read. Its dependencies are the names the server
// imports, resolved from local directories so the install is offline and fast: an empty
// dependency set cannot tell a working hook from one that exits 0 having installed nothing.
const FIXTURES = { "@modelcontextprotocol/sdk": "sdk", zod: "zod" };

const buildProbe = async (prepare) => {
  const root = await mkdtemp(join(tmpdir(), "cdm-plugin-"));
  await mkdir(join(root, ".claude-plugin"));
  await cp(resolve(ROOT, ".claude-plugin/ensure-deps.mjs"), join(root, ".claude-plugin/ensure-deps.mjs"));

  const dependencies = {};
  for (const [name, dir] of Object.entries(FIXTURES)) {
    await mkdir(join(root, "fixtures", dir), { recursive: true });
    await writeFile(join(root, "fixtures", dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }), "utf8");
    dependencies[name] = `file:./fixtures/${dir}`;
  }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "cdm-plugin-probe", version: "1.0.0", private: true, dependencies }),
    "utf8"
  );

  if (prepare) await prepare(root);
  return root;
};

const runHook = (root) =>
  promisify(execFile)(process.execPath, [join(root, ".claude-plugin", "ensure-deps.mjs")], { timeout: 120_000 });

const importable = (root, name) => existsSync(join(root, "node_modules", name, "package.json"));

test("the SessionStart hook can spawn npm on this platform", async () => {
  // npm.cmd is a batch file, and Node refuses to spawn one without a shell — the failure is
  // `spawnSync npm.cmd EINVAL` on the first session after a plugin install, before doctor
  // exists to report it. Only a real spawn catches that, so this runs the hook.
  const root = await buildProbe();
  const { stdout } = await runHook(root);

  assert.doesNotMatch(stdout, /dependency install failed/);
  for (const name of Object.keys(FIXTURES)) {
    assert.ok(importable(root, name), `${name} must be installed once the hook returns`);
  }
});

// npm writes a lockfile when it runs, so its absence is the observable proof the hook
// skipped and its presence the proof it did not.
const installRan = (root) => existsSync(join(root, "package-lock.json"));
const placeDep = async (root, name, complete) => {
  await mkdir(join(root, "node_modules", name), { recursive: true });
  if (complete) await writeFile(join(root, "node_modules", name, "package.json"), JSON.stringify({ name }), "utf8");
};

test("the dependency sentinel repairs every incomplete install", async () => {
  // A half-finished install leaves directories behind. Skipping on their bare existence keeps
  // the plugin broken on every later session, with the server still failing to import. Asserted
  // by running the hook rather than by reading it: the source can name a path in a comment and
  // still skip wrong.
  const complete = await buildProbe(async (root) => {
    for (const name of Object.keys(FIXTURES)) await placeDep(root, name, true);
  });
  await runHook(complete);
  assert.ok(!installRan(complete), "a complete install must be left alone");

  const bare = await buildProbe(async (root) => {
    await mkdir(join(root, "node_modules"), { recursive: true });
  });
  await runHook(bare);
  assert.ok(installRan(bare), "an empty node_modules must still install");

  // The SDK is only one of the names the server imports; an install that died after it and
  // before zod satisfies a check that names the SDK alone.
  const partialTree = await buildProbe(async (root) => {
    await placeDep(root, "@modelcontextprotocol/sdk", true);
  });
  await runHook(partialTree);
  assert.ok(installRan(partialTree), "a dependency missing beside the SDK must still install");
  assert.ok(importable(partialTree, "zod"), "the repair must land the missing dependency");

  // npm extracts into the package directory, so an interrupted unpack leaves the directory
  // present and its package.json absent.
  const partialPackage = await buildProbe(async (root) => {
    await placeDep(root, "@modelcontextprotocol/sdk", false);
    await placeDep(root, "zod", true);
  });
  await runHook(partialPackage);
  assert.ok(installRan(partialPackage), "a half-extracted dependency must still install");
  assert.ok(importable(partialPackage, "@modelcontextprotocol/sdk"), "the repair must complete the extraction");
});
