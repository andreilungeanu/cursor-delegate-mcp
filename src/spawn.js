import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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

/** @param {string} value */
function powerShellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Resolve and execute through PowerShell without asking Node to create a cmd.exe shell.
 * EncodedCommand avoids a lossy command-line quoting round trip for workspace paths.
 *
 * @param {string} command
 * @param {string[]} args
 */
function windowsPowerShellSpawn(command, args) {
  const invocation = [`& ${powerShellQuote(command)}`, ...args.map(powerShellQuote)].join(" ");
  const encoded = Buffer.from(`${invocation}; exit $LASTEXITCODE`, "utf16le").toString("base64");
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    options: {
      shell: false,
      windowsHide: true,
      env: agentEnv(),
    },
  };
}

function defaultAgentCommand() {
  if (process.platform !== "win32") return "cursor-agent";
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const localLauncher = path.win32.join(localAppData, "cursor-agent", "cursor-agent.ps1");
    if (existsSync(localLauncher)) return localLauncher;
  }
  // PowerShell resolves the backward-compatible command and its .ps1 launcher from PATH.
  return "cursor-agent";
}

// Windows uses an explicit PowerShell process so the launcher resolves without cmd.exe.
export function resolveAcpSpawn() {
  const configuredCommand = process.env.ACP_AGENT_COMMAND;
  const command = configuredCommand || defaultAgentCommand();
  const args = process.env.ACP_AGENT_ARGS
    ? splitArgs(process.env.ACP_AGENT_ARGS)
    : ["acp"];
  if (process.platform === "win32") {
    const isPowerShellScript = /\.ps1$/i.test(command);
    if (configuredCommand && !isPowerShellScript) {
      return {
        command,
        args,
        options: { shell: false, windowsHide: true, env: agentEnv() },
      };
    }
    return windowsPowerShellSpawn(command, args);
  }
  return { command, args, options: { shell: false } };
}
