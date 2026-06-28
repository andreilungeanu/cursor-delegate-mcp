import process from "node:process";

export function resolveAcpSpawn() {
  const command = process.env.ACP_AGENT_COMMAND || "agent";
  const args = process.env.ACP_AGENT_ARGS
    ? process.env.ACP_AGENT_ARGS.split(" ").filter(Boolean)
    : ["acp"];
  return { command, args, options: { shell: process.platform === "win32" } };
}
