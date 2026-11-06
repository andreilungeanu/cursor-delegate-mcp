import { test } from "node:test";
import assert from "node:assert/strict";
import { splitArgs, resolveAcpSpawn } from "../src/spawn.js";

test("splitArgs splits plain whitespace-separated tokens", () => {
  assert.deepEqual(splitArgs("acp --verbose"), ["acp", "--verbose"]);
  assert.deepEqual(splitArgs("  acp   --verbose  "), ["acp", "--verbose"]);
});

test("splitArgs keeps double-quoted arguments with spaces intact", () => {
  assert.deepEqual(splitArgs('acp --config "C:\\Program Files\\agent\\acp.json"'), [
    "acp",
    "--config",
    "C:\\Program Files\\agent\\acp.json",
  ]);
});

test("splitArgs keeps single-quoted arguments intact", () => {
  assert.deepEqual(splitArgs("run 'a b c' end"), ["run", "a b c", "end"]);
});

test("splitArgs handles empty and undefined input", () => {
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs(undefined), []);
});

test("resolveAcpSpawn defaults to cursor-agent acp when env vars are unset", () => {
  const prevCmd = process.env.ACP_AGENT_COMMAND;
  const prevArgs = process.env.ACP_AGENT_ARGS;
  delete process.env.ACP_AGENT_COMMAND;
  delete process.env.ACP_AGENT_ARGS;
  try {
    const spec = resolveAcpSpawn();
    if (process.platform === "win32") {
      assert.equal(spec.command, "powershell.exe");
      assert.equal(spec.options.shell, false);
      assert.equal(spec.options.windowsHide, true);
      const encoded = spec.args.at(-1);
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      assert.match(script, /cursor-agent(?:\.ps1)?/);
      assert.match(script, /'acp'/);
    } else {
      assert.equal(spec.command, "cursor-agent");
      assert.deepEqual(spec.args, ["acp"]);
      assert.equal(spec.options.shell, false);
    }
  } finally {
    if (prevCmd !== undefined) process.env.ACP_AGENT_COMMAND = prevCmd;
    if (prevArgs !== undefined) process.env.ACP_AGENT_ARGS = prevArgs;
  }
});

test("an explicit Windows executable is spawned directly without a shell", {
  skip: process.platform !== "win32" ? "Windows launcher selection" : false,
}, () => {
  const prevCmd = process.env.ACP_AGENT_COMMAND;
  process.env.ACP_AGENT_COMMAND = process.execPath;
  try {
    const spec = resolveAcpSpawn();
    assert.equal(spec.command, process.execPath);
    assert.deepEqual(spec.args, ["acp"]);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.windowsHide, true);
  } finally {
    if (prevCmd !== undefined) process.env.ACP_AGENT_COMMAND = prevCmd;
    else delete process.env.ACP_AGENT_COMMAND;
  }
});

test("resolveAcpSpawn honors ACP_AGENT_ARGS with quoted segments", () => {
  const prevCmd = process.env.ACP_AGENT_COMMAND;
  const prevArgs = process.env.ACP_AGENT_ARGS;
  if (process.platform === "win32") process.env.ACP_AGENT_COMMAND = process.execPath;
  process.env.ACP_AGENT_ARGS = 'acp --workdir "dir with spaces"';
  try {
    const spec = resolveAcpSpawn();
    assert.deepEqual(spec.args, ["acp", "--workdir", "dir with spaces"]);
  } finally {
    if (prevCmd !== undefined) process.env.ACP_AGENT_COMMAND = prevCmd;
    else delete process.env.ACP_AGENT_COMMAND;
    if (prevArgs !== undefined) process.env.ACP_AGENT_ARGS = prevArgs;
    else delete process.env.ACP_AGENT_ARGS;
  }
});

// Real spawn with the resolved options: the child reports the environment it actually got.
test("resolveAcpSpawn drops MSYSTEM and SHELL from the agent's environment on win32", { skip: process.platform !== "win32" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const prev = { MSYSTEM: process.env.MSYSTEM, SHELL: process.env.SHELL };
  process.env.MSYSTEM = "MINGW64";
  process.env.SHELL = "C:/Program Files/Git/usr/bin/bash.exe";
  try {
    const { options } = resolveAcpSpawn();
    const script = "console.log(JSON.stringify([process.env.MSYSTEM ?? null, process.env.SHELL ?? null, process.env.PATH ? 'path' : null]))";
    const out = spawnSync(process.execPath, ["-e", script], { ...options, shell: false, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out.stdout), [null, null, "path"]);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
