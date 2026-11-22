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

// On Windows cursor-agent writes hook commands as PowerShell but runs them in Git Bash when it sees
// MSYSTEM or a Git Bash SHELL, which a host in Git Bash (Claude Code) passes down; bash then blocks
// every hooked tool call. Without the two vars the agent uses PowerShell.
const WIN32_DROPPED_ENV = new Set(["MSYSTEM", "SHELL"]);

function agentEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !WIN32_DROPPED_ENV.has(key.toUpperCase())));
}

// shell:true on win32 lets a .cmd launcher resolve, and means cmd.exe parses the command line.
// Safe only because both values come from the environment, already as trusted as this process.
// Never route host- or caller-supplied values into them: that is command injection.
export function resolveAcpSpawn() {
  const command = process.env.ACP_AGENT_COMMAND || "cursor-agent";
  const args = process.env.ACP_AGENT_ARGS
    ? splitArgs(process.env.ACP_AGENT_ARGS)
    : ["acp"];
  if (process.platform !== "win32") return { command, args, options: { shell: false } };
  const env = agentEnv();
  // cmd.exe hands a .ps1 to its file association instead of running it, so start it the way
  // cursor-agent.cmd starts cursor-agent.ps1. One that does not resolve stays as given, for the
  // not-installed check.
  const name = command.replace(/^["']|["']$/g, "");
  const script = /\.ps1$/i.test(name) ? findCommand(name, env) : null;
  if (script) {
    const rootKey = Object.keys(env).find((k) => k.toUpperCase() === "SYSTEMROOT");
    const powershell = rootKey && env[rootKey]
      ? path.win32.join(env[rootKey], "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return {
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      options: { shell: false, env },
    };
  }
  return { command, args, options: { shell: true, env } };
}

// Under shell:true Node hands cmd.exe one unquoted line, so a value with a space or metacharacter
// splits there. Quoted at the spawn sites, so the spec keeps plain args. A value already holding a
// quote passes as given: cmd cannot nest them, and pre-quoted paths worked before. cmd still
// expands %VAR% inside quotes.
function cmdQuote(value) {
  const s = String(value);
  if (s.includes('"') || (s !== "" && !/[\s&|<>^(),;=]/.test(s))) return s;
  // Doubled so the child's argv parser does not read a trailing backslash as escaping the quote.
  return `"${s.replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * The command and args to hand spawn() for a spec's options.
 * @param {string} command @param {string[]} args @param {{ shell?: boolean | string } | undefined} options
 */
export function shellArgv(command, args, options) {
  if (!(options?.shell && process.platform === "win32")) return { command, args };
  return { command: cmdQuote(command), args: args.map(cmdQuote) };
}

// Through a shell the spawn always succeeds (cmd.exe exits 1, "is not recognized"), so a missing
// launcher is looked up first to report it as not installed. Mirrors cmd: a path as given, a bare
// name on each PATH entry, each with and without each PATHEXT extension. Pass the env the child
// gets: on win32, agentEnv().
export function commandExists(command, env = process.env) {
  return findCommand(command, env) !== null;
}

/** The file that lookup lands on, or null. */
function findCommand(command, env) {
  const name = String(command || "").replace(/^["']|["']$/g, "");
  if (!name) return null;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === "PATHEXT");
  const exts = ["", ...String((extKey && env[extKey]) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const isFile = (p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };
  const hit = (base) => {
    for (const ext of exts) {
      for (const p of [base + ext, base + ext.toLowerCase()]) if (isFile(p)) return p;
    }
    return null;
  };
  if (/[\\/]/.test(name)) return hit(name);
  const dirs = String((pathKey && env[pathKey]) || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = hit(path.join(dir.replace(/^"|"$/g, ""), name));
    if (found) return found;
  }
  return null;
}
