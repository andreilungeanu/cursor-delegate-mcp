import process from "node:process";
import { lstatSync, readFileSync, statSync } from "node:fs";
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
  const win32 = process.platform === "win32";
  return { command, args, options: { shell: win32, ...(win32 ? { env: agentEnv() } : {}) } };
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
 * What to hand spawn() for a spec. Applied at each spawn site, after doctor has built its
 * --version args from the spec as configured.
 * @param {string} command @param {string[]} args
 * @param {{ shell?: boolean | string, env?: NodeJS.ProcessEnv } | undefined} options
 */
export function spawnArgv(command, args, options) {
  if (!(options?.shell && process.platform === "win32")) return { command, args, options };
  const env = options.env || process.env;
  // cmd.exe hands a .ps1 to its file association instead of running it, so start it the way
  // cursor-agent.cmd starts cursor-agent.ps1. Only that exact file: x.ps1.cmd is cmd's to run.
  // A .cmd that only does that runs its .ps1 the same way, skipping cmd.exe.
  const name = String(command).replace(/^["']|["']$/g, "");
  const script = /\.ps1$/i.test(name) ? findCommand(name, env, true) : forwardedScript(findCommand(name, env), env);
  if (script) {
    const rootKey = Object.keys(env).find((k) => k.toUpperCase() === "SYSTEMROOT");
    const powershell = rootKey && env[rootKey]
      ? path.win32.join(env[rootKey], "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return {
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      options: { ...options, shell: false },
    };
  }
  // One line and no args array: Node 24 warns (DEP0190) on args under shell:true.
  return { command: [command, ...args].map(cmdQuote).join(" "), args: [], options };
}

// cursor-agent.cmd (and agent.cmd, a copy) turns on delayed expansion, then runs cursor-agent.ps1
// from its own folder through powershell.exe -File; the .ps1 repeats the .cmd's update step.
// Through cmd.exe and that .cmd, !, %VAR%, ^ and quotes in the args are rewritten before the agent
// sees them. The .ps1 when the .cmd's PowerShell line forwards its args (%*) to a script in the
// .cmd's folder (%~dp0, or a variable set from it), else null.
function forwardedScript(file, env) {
  if (!file || !/\.(cmd|bat)$/i.test(file)) return null;
  let text;
  try {
    if (statSync(file).size > 64 * 1024) return null;
    text = readFileSync(file, "latin1");
  } catch {
    return null;
  }
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dirVars = [...text.matchAll(/^\s*set\s+"?(\w+)=%~dp0"?\s*$/gim)].map((m) => `%${m[1]}%`);
  const ownDir = ["%~dp0", ...dirVars].map(escape).join("|");
  const forwards = new RegExp(`powershell(?:\\.exe)?"?[^\\r\\n]*\\s-File\\s+"(?:${ownDir})\\\\?([^"\\\\/:\\r\\n]+\\.ps1)"\\s+%\\*`, "i");
  const target = text.match(forwards)?.[1];
  return target ? findCommand(path.join(path.dirname(file), target), env, true) : null;
}

// Through a shell the spawn always succeeds (cmd.exe exits 1, "is not recognized"), so a missing
// launcher is looked up first to report it as not installed. Mirrors cmd: a path as given, a bare
// name on each PATH entry, each with and without each PATHEXT extension. Pass the env the child
// gets: on win32, agentEnv().
export function commandExists(command, env = process.env) {
  return findCommand(command, env) !== null;
}

/** The file that lookup lands on, or null. exact skips the PATHEXT extensions. */
function findCommand(command, env, exact = false) {
  const name = String(command || "").replace(/^["']|["']$/g, "");
  if (!name) return null;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === "PATHEXT");
  const exts = exact ? [""] : ["", ...String((extKey && env[extKey]) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch (e) {
      // A Store app's alias (WindowsApps\pwsh.exe) is a link into a folder this user cannot stat,
      // so stat fails with EACCES, yet cmd runs it. A link to a missing file fails with ENOENT.
      if (process.platform !== "win32" || (e.code !== "EACCES" && e.code !== "EPERM")) return false;
      try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
    }
  };
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
