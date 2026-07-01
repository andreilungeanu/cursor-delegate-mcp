import process from "node:process";
import { spawn } from "node:child_process";
import { AcpClient } from "./acp-client.js";
import { resolveAcpSpawn } from "./spawn.js";
import { VERSION } from "./version.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_LOG_SIZE = "2000";

function formatCommand({ command, args }) {
  return args?.length ? `${command} ${args.join(" ")}` : command;
}

export function probeAgentVersion(spawnSpec) {
  const { command, options } = spawnSpec;
  const isJsScript = /\.js$/i.test(command);
  const execCommand = isJsScript ? process.execPath : command;
  const execArgs = isJsScript ? [command, "--version"] : ["--version"];
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(execCommand, execArgs, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => finish({ found: false, version: null }));
    child.on("close", (code) => {
      finish({
        found: true,
        version: code === 0 ? stdout.trim() || null : null,
      });
    });
  });
}

async function runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs }) {
  const client = clientFactory({ spawnSpec });
  const workspaceDir = workspace || process.cwd();
  let timer;
  try {
    const work = (async () => {
      await client.start();
      await client.initialize();
      await client.newSession(workspaceDir);
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { client.stop(); } catch {}
        reject(new Error(`Handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    await Promise.race([work, timeout]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
    try { client.stop(); } catch {}
  }
}

export async function runDoctor({
  getClientInfo = () => ({ capabilities: {}, version: {} }),
  deep = false,
  spawnSpec = resolveAcpSpawn(),
  clientFactory = (opts) => new AcpClient(opts),
  workspace,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
} = {}) {
  const { capabilities, version } = getClientInfo();
  const agentProbe = await probeAgentVersion(spawnSpec);

  const out = {
    plugin: { version: VERSION },
    client: {
      name: version?.name ?? null,
      version: version?.version ?? null,
      capabilities: capabilities ?? {},
      supportsElicitation: !!capabilities?.elicitation,
    },
    agent: {
      found: agentProbe.found,
      command: formatCommand(spawnSpec),
      version: agentProbe.version,
    },
    env: {
      ACP_LOG_SIZE: process.env.ACP_LOG_SIZE !== undefined ? process.env.ACP_LOG_SIZE : DEFAULT_LOG_SIZE,
    },
  };

  if (deep) {
    out.agent.handshake = await runDeepHandshake({
      spawnSpec,
      clientFactory,
      workspace,
      timeoutMs: handshakeTimeoutMs,
    });
  }

  return out;
}
