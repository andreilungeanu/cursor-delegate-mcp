import process from "node:process";

export function splitArgs(raw) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of String(raw || "").matchAll(re)) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
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
  return { command, args, options: { shell: process.platform === "win32" } };
}
