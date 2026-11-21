import process from "node:process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export function splitArgs(raw) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of String(raw || "").matchAll(re)) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

// On Windows cursor-agent writes every hook command as PowerShell, but runs it in Git Bash when
// it finds MSYSTEM, or a SHELL naming Git Bash, in its environment. A host running in Git Bash
// (Claude Code on Windows) passes both down, bash rejects the PowerShell line, and the agent
// reports every hooked tool call as blocked. Dropped, the agent falls back to PowerShell, the
// shell it uses when started outside Git Bash.
const WIN32_DROPPED_ENV = new Set(["MSYSTEM", "SHELL"]);

function agentEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !WIN32_DROPPED_ENV.has(key.toUpperCase())));
}

// shell:true on win32 is what lets a .cmd/.ps1 launcher resolve at all, and it means the
// command and args are parsed by cmd.exe. Safe only because both come from the environment,
// which is already as trusted as this process: anything that can set them can run code here
// anyway. Routing host- or caller-supplied values into either variable would turn this into a
// command-injection path, so don't.
export function resolveAcpSpawn() {
  const command = process.env.ACP_AGENT_COMMAND || "cursor-agent";
  const args = process.env.ACP_AGENT_ARGS
    ? splitArgs(process.env.ACP_AGENT_ARGS)
    : ["acp"];
  const win32 = process.platform === "win32";
  return { command, args, options: { shell: win32, ...(win32 ? { env: agentEnv() } : {}) } };
}

// Through a shell the spawn itself always succeeds: cmd.exe starts, fails to find the launcher and
// exits 1 with a localized "is not recognized" line, so Node's spawn 'error' event never fires and
// a missing cursor-agent reads as an agent crash. Resolving the launcher first is what lets that
// case be reported as not installed. Mirrors cmd's lookup: a path is checked as given, a bare name
// against each PATH entry, both with and without each PATHEXT extension. Pass the env the child
// will get: on win32 that is agentEnv(), not process.env.
export function commandExists(command, env = process.env) {
  const name = String(command || "").replace(/^["']|["']$/g, "");
  if (!name) return false;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === "PATHEXT");
  const exts = ["", ...String((extKey && env[extKey]) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const isFile = (p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };
  const hit = (base) => exts.some((ext) => isFile(base + ext) || isFile(base + ext.toLowerCase()));
  if (/[\\/]/.test(name)) return hit(name);
  const dirs = String((pathKey && env[pathKey]) || "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => hit(path.join(dir.replace(/^"|"$/g, ""), name)));
}
