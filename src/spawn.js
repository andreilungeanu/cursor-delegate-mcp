import process from "node:process";

// Shell-like tokenizer: whitespace splits, double/single quotes group.
export function splitArgs(raw) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of String(raw || "").matchAll(re)) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

export function resolveAcpSpawn() {
  const command = process.env.ACP_AGENT_COMMAND || "agent";
  const args = process.env.ACP_AGENT_ARGS
    ? splitArgs(process.env.ACP_AGENT_ARGS)
    : ["acp"];
  return { command, args, options: { shell: process.platform === "win32" } };
}
