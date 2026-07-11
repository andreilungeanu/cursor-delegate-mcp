import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "run this smoke test through npm so npm_execpath is available");
const runNpm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
const temp = mkdtempSync(join(tmpdir(), "cursor-delegate-pack-"));

try {
  const packResult = JSON.parse(runNpm(
    ["pack", "--json", "--pack-destination", temp],
    { cwd: root, encoding: "utf8" }
  ));
  const tarball = resolve(temp, packResult[0].filename);
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true }), "utf8");
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: temp, stdio: "inherit" }
  );

  const installed = join(temp, "node_modules", "cursor-delegate-mcp");
  for (const rel of [
    "src/server.js",
    "README.md",
    "LICENSE",
    "PRIVACY.md",
    "SECURITY.md",
    "TERMS.md",
  ]) {
    assert.ok(existsSync(join(installed, rel)), `packed artifact is missing ${rel}`);
  }
  // Plugin manifests, skills, and assets are Git-install concerns; the npm
  // artifact is runtime-only. Guard against them creeping back into the tarball.
  for (const rel of ["plugin.json", ".mcp.copilot.json", ".codex-plugin", "skills", "assets", "commands"]) {
    assert.ok(!existsSync(join(installed, rel)), `packed artifact must not ship ${rel}`);
  }

  // Launch through an aliased directory so entrypoint detection cannot rely on
  // the command-line spelling matching the module loader's canonical path.
  const installedAlias = join(temp, "installed-alias");
  symlinkSync(installed, installedAlias, process.platform === "win32" ? "junction" : "dir");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installedAlias, "src", "server.js")],
    cwd: temp,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr = (serverStderr + chunk.toString()).slice(-8192);
  });
  const client = new Client({ name: "packed-artifact-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    const stderr = serverStderr.trim() || "<empty>";
    throw new Error(`packed server failed to connect: ${error?.message || error}\nserver stderr:\n${stderr}`, {
      cause: error,
    });
  }
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["cancel", "delegate", "doctor"]);
  } finally {
    await client.close();
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
