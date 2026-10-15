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
