import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitArgs, resolveAcpSpawn, commandExists, spawnArgv } from "../src/spawn.js";

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

test("splitArgs joins a quoted section to the token it sits in", () => {
  assert.deepEqual(splitArgs('acp --log-file="C:\\logs & traces\\agent.log"'), ["acp", "--log-file=C:\\logs & traces\\agent.log"]);
  assert.deepEqual(splitArgs('acp "" end'), ["acp", "", "end"]);
});

test("splitArgs keeps a quote inside a word as part of the argument", () => {
  assert.deepEqual(splitArgs("--log C:\\Users\\O'Brien\\agent.log"), ["--log", "C:\\Users\\O'Brien\\agent.log"]);
  assert.deepEqual(splitArgs("--log=C:\\it's\\O'Brien.log end"), ["--log=C:\\it's\\O'Brien.log", "end"]);
  assert.deepEqual(splitArgs('say 5" "unclosed'), ["say", '5"', '"unclosed']);
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
    assert.equal(spec.command, "cursor-agent");
    assert.deepEqual(spec.args, ["acp"]);
  } finally {
    if (prevCmd !== undefined) process.env.ACP_AGENT_COMMAND = prevCmd;
    if (prevArgs !== undefined) process.env.ACP_AGENT_ARGS = prevArgs;
  }
});

test("resolveAcpSpawn honors ACP_AGENT_ARGS with quoted segments", () => {
  const prevArgs = process.env.ACP_AGENT_ARGS;
  process.env.ACP_AGENT_ARGS = 'acp --workdir "dir with spaces"';
  try {
    const spec = resolveAcpSpawn();
    assert.deepEqual(spec.args, ["acp", "--workdir", "dir with spaces"]);
  } finally {
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

// cmd.exe hands a .ps1 to its file association, an editor by default, instead of running it, so
// ACP_AGENT_COMMAND pointing at cursor-agent.ps1 never started the agent. The spec is checked
// before anything spawns: on the old route the spawn would open the script, not run it.
const PS1_AGENT = [
  "if ($args -contains '--version') { Write-Output 'ps1-agent 1.0'; exit 0 }",
  "[Console]::Error.Write((ConvertTo-Json -InputObject @($args) -Compress)); exit 3",
].join("\r\n");

function withAgentEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { return fn(); } finally { restore(); }
}

test("a .ps1 ACP_AGENT_COMMAND runs through PowerShell with its arguments intact", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { AcpClient } = await import("../src/acp-client.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  try {
    const script = path.join(dir, "agent.ps1");
    writeFileSync(script, PS1_AGENT);
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: script, ACP_AGENT_ARGS: '"two words" acp' }, () => resolveAcpSpawn());
    const argv = spawnArgv(spec.command, spec.args, spec.options);
    assert.match(argv.command, /powershell\.exe$/i, "the script must not go to cmd.exe");
    assert.deepEqual(argv.args.slice(-3), [script, "two words", "acp"]);
    const client = new AcpClient({ spawnSpec: spec });
    const exit = new Promise((resolve) => client.once("exit", resolve));
    await client.start();
    const info = await exit;
    assert.equal(info.code, 3, info.stderr);
    assert.deepEqual(JSON.parse(info.stderr), ["two words", "acp"]);
    await client.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reads a .ps1 launcher's version, and resolves a bare .ps1 name on PATH", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { runDoctor } = await import("../src/doctor.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  try {
    writeFileSync(path.join(dir, "agent.ps1"), PS1_AGENT);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: "agent.ps1", ACP_AGENT_ARGS: undefined, [pathKey]: dir + path.delimiter + process.env[pathKey] }, () => resolveAcpSpawn());
    const argv = spawnArgv(spec.command, spec.args, spec.options);
    assert.match(argv.command, /powershell\.exe$/i);
    assert.equal(argv.args.at(-2), path.join(dir, "agent.ps1"), "the bare name resolves to the script on PATH");
    const out = await runDoctor({ spawnSpec: spec });
    assert.equal(out.agent.found, true);
    assert.equal(out.agent.version, "ps1-agent 1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reads a .ps1 launcher's version when ACP_AGENT_ARGS has no acp token", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { runDoctor } = await import("../src/doctor.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  try {
    const script = path.join(dir, "agent.ps1");
    writeFileSync(script, PS1_AGENT);
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: script, ACP_AGENT_ARGS: "--stdio" }, () => resolveAcpSpawn());
    const out = await runDoctor({ spawnSpec: spec });
    assert.equal(out.agent.error, undefined);
    assert.equal(out.agent.version, "ps1-agent 1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .ps1 ACP_AGENT_COMMAND that does not exist is reported as spawn-failed", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { AcpClient } = await import("../src/acp-client.js");
  const missing = path.join(tmpdir(), "no-such-dir-xyz", "agent.ps1");
  const spec = withAgentEnv({ ACP_AGENT_COMMAND: missing, ACP_AGENT_ARGS: undefined }, () => resolveAcpSpawn());
  assert.equal(spec.command, missing);
  await assert.rejects(() => new AcpClient({ spawnSpec: spec }).start(), (err) => err.reason === "spawn-failed");
});

// Node warns (DEP0190) only from 24 on, and once per process, so each site gets its own process.
test("launching through cmd.exe prints no DEP0190 warning, from the client or doctor", { skip: process.platform !== "win32" && "cmd.exe launch" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const src = (name) => JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "src", name)).href);
  const sites = {
    client: `const { AcpClient } = await import(${src("acp-client.js")});
      const c = new AcpClient({ spawnSpec: { command: "node", args: ["-v"], options: { shell: true } } });
      await new Promise((r) => { c.once("exit", r); c.start(); });`,
    doctor: `const { runDoctor } = await import(${src("doctor.js")});
      await runDoctor({ spawnSpec: { command: "node", args: ["acp"], options: { shell: true } } });`,
  };
  for (const [site, script] of Object.entries(sites)) {
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(out.status, 0, `${site}: ${out.stderr}`);
    assert.doesNotMatch(out.stderr, /DEP0190/, site);
  }
});

// The shape of cursor-agent.cmd: delayed expansion, then its folder's .ps1 via powershell.exe.
const forwardingCmd = (base, dir = "%SCRIPT_DIR%") => [
  "@echo off",
  "setlocal enabledelayedexpansion",
  'set "SCRIPT_DIR=%~dp0"',
  'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"',
  `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${dir}\\${base}.ps1" %*`,
  "",
].join("\r\n");

function withPathDir(dir, vars, fn) {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  return withAgentEnv({ ...vars, [pathKey]: dir + path.delimiter + process.env[pathKey] }, fn);
}

test("a .cmd that only forwards to its .ps1 runs the .ps1 through PowerShell, so cmd leaves its arguments alone", { skip: process.platform !== "win32" && "Windows launcher" }, async () => {
  const { AcpClient } = await import("../src/acp-client.js");
  const dir = mkdtempSync(path.join(tmpdir(), "fwd agent "));
  try {
    writeFileSync(path.join(dir, "fwdagent.cmd"), forwardingCmd("fwdagent"));
    writeFileSync(path.join(dir, "fwdagent.ps1"), PS1_AGENT);
    const spec = withPathDir(dir, { ACP_AGENT_COMMAND: "fwdagent", ACP_AGENT_ARGS: "a!b %OS% ^caret acp" }, () => resolveAcpSpawn());
    const argv = spawnArgv(spec.command, spec.args, spec.options);
    assert.match(argv.command, /powershell\.exe$/i, "the .cmd's own .ps1 runs without cmd.exe");
    assert.equal(argv.args.at(-5), path.join(dir, "fwdagent.ps1"));
    const client = new AcpClient({ spawnSpec: spec });
    const exit = new Promise((resolve) => client.once("exit", resolve));
    await client.start();
    const info = await exit;
    assert.equal(info.code, 3, info.stderr);
    assert.deepEqual(JSON.parse(info.stderr), ["a!b", "%OS%", "^caret", "acp"]);
    await client.stop();
    // Like agent.cmd: a .cmd that forwards to a differently named .ps1 in its folder.
    writeFileSync(path.join(dir, "fwdalias.cmd"), forwardingCmd("fwdagent", "%~dp0"));
    const alias = withPathDir(dir, { ACP_AGENT_COMMAND: "fwdalias", ACP_AGENT_ARGS: undefined }, () => resolveAcpSpawn());
    const aliasArgv = spawnArgv(alias.command, alias.args, alias.options);
    assert.match(aliasArgv.command, /powershell\.exe$/i);
    assert.equal(aliasArgv.args.at(-2), path.join(dir, "fwdagent.ps1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .cmd stays on cmd.exe unless it only forwards to an existing .ps1 in its own folder", { skip: process.platform !== "win32" && "Windows launcher" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fwd agent "));
  const far = mkdtempSync(path.join(tmpdir(), "fwd far "));
  try {
    // Forwards, but the .ps1 is missing.
    writeFileSync(path.join(dir, "noscript.cmd"), forwardingCmd("noscript"));
    // Has a .ps1 beside it, but runs something else.
    writeFileSync(path.join(dir, "other.cmd"), '@echo off\r\nnode "%~dp0other.js" %*\r\n');
    writeFileSync(path.join(dir, "other.ps1"), PS1_AGENT);
    // Forwards to a script in another folder, with a same-named .ps1 beside it.
    writeFileSync(path.join(far, "farscript.ps1"), PS1_AGENT);
    writeFileSync(path.join(dir, "farscript.cmd"), forwardingCmd("farscript", far));
    writeFileSync(path.join(dir, "farscript.ps1"), PS1_AGENT);
    for (const name of ["noscript", "other", "farscript"]) {
      const spec = withPathDir(dir, { ACP_AGENT_COMMAND: name, ACP_AGENT_ARGS: undefined }, () => resolveAcpSpawn());
      const argv = spawnArgv(spec.command, spec.args, spec.options);
      assert.doesNotMatch(argv.command, /powershell\.exe$/i, name);
      assert.deepEqual(argv.args, [], name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(far, { recursive: true, force: true });
  }
});

test("only an existing .ps1 file itself is run through PowerShell", { skip: process.platform !== "win32" && "Windows launcher" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ps1 agent "));
  try {
    writeFileSync(path.join(dir, "agent.ps1.cmd"), "@echo off\r\n");
    const spec = withAgentEnv({ ACP_AGENT_COMMAND: path.join(dir, "agent.ps1"), ACP_AGENT_ARGS: undefined }, () => resolveAcpSpawn());
    const argv = spawnArgv(spec.command, spec.args, spec.options);
    assert.doesNotMatch(argv.command, /powershell\.exe$/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commandExists finds a launcher on PATH with and without a PATHEXT extension", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cmd-exists-"));
  try {
    writeFileSync(path.join(dir, "fakecursor.cmd"), "@echo off\n");
    writeFileSync(path.join(dir, "plaincursor"), "");
    mkdirSync(path.join(dir, "dironly"));
    const env = { Path: ["/nowhere", dir].join(path.delimiter), PATHEXT: ".EXE;.CMD" };
    assert.equal(commandExists("fakecursor", env), true, "bare name resolves through PATHEXT");
    assert.equal(commandExists("fakecursor.cmd", env), true, "name with its extension");
    assert.equal(commandExists("plaincursor", env), true, "extensionless file");
    assert.equal(commandExists("dironly", env), false, "a directory is not a launcher");
    assert.equal(commandExists("missingcursor", env), false);
    assert.equal(commandExists(path.join(dir, "fakecursor"), env), true, "a path is checked as given");
    assert.equal(commandExists(`"${path.join(dir, "fakecursor.cmd")}"`, env), true, "quotes are stripped");
    assert.equal(commandExists(path.join(dir, "missingcursor"), env), false);
    assert.equal(commandExists("fakecursor", { PATH: "/nowhere" }), false, "only the given env's PATH is searched");
    assert.equal(commandExists("", env), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A WindowsApps entry that lstat sees as a link and stat cannot read: a Store app's alias.
function findAppExecAlias() {
  const dir = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps");
  let names = [];
  try { names = readdirSync(dir).filter((n) => /\.exe$/i.test(n)); } catch {}
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!lstatSync(file).isSymbolicLink()) continue;
      statSync(file);
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") return { dir, name };
    }
  }
  return null;
}

test("commandExists finds a Store app execution alias", { skip: process.platform !== "win32" ? "Windows launcher" : !findAppExecAlias() && "no app execution alias on this machine" }, () => {
  const { dir, name } = findAppExecAlias();
  const env = { Path: dir, PATHEXT: ".EXE" };
  assert.equal(commandExists(name.replace(/\.exe$/i, ""), env), true, "bare name resolves through PATHEXT");
  assert.equal(commandExists(name, env), true, "name with its extension");
  assert.equal(commandExists(path.join(dir, name), env), true, "a path is checked as given");
});

test("commandExists does not find a link whose target is gone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cmd-exists-"));
  try {
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(path.join(dir, "missing"), path.join(dir, "gone.exe"), "junction");
    const env = { Path: dir, PATHEXT: ".EXE" };
    assert.equal(commandExists("gone", env), false);
    assert.equal(commandExists(path.join(dir, "gone.exe"), env), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
