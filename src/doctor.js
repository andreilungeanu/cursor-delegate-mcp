import process from "node:process";
import { spawn } from "node:child_process";
import { AcpClient } from "./acp-client.js";
import { resolveAcpSpawn } from "./spawn.js";
import { treeKill } from "./proc.js";
import { readPackageVersion } from "./version.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_LOG_SIZE = "2000";

function formatCommand({ command, args }) {
  return args?.length ? `${command} ${args.join(" ")}` : command;
}

// A launcher that accepts --version and then never answers used to hang doctor forever — and
// doctor is the tool you run when delegation is already broken, so a wedged agent is exactly
// the case it has to survive. Deep handshakes have always been time-boxed; this is that guard
// applied to the shallow probe that runs on every call.
export function probeAgentVersion(spawnSpec, timeoutMs = VERSION_PROBE_TIMEOUT_MS) {
  const { command, options } = spawnSpec;
  const isJsScript = /\.js$/i.test(command);
  const execCommand = isJsScript ? process.execPath : command;
  const execArgs = isJsScript ? [command, "--version"] : ["--version"];
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    timer = setTimeout(() => {
      // treeKill, not child.kill: the spawn spec carries shell:true on win32, where a plain
      // kill only reaches the wrapper and leaves the launcher running.
      if (child.pid) treeKill(child.pid).catch(() => {});
      // The launcher exists — it spawned — it just never answered, which is a different
      // diagnosis from "not installed" and has to read that way.
      finish({ found: true, version: null, error: `version probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs }) {
  const client = clientFactory({ spawnSpec });
  const workspaceDir = workspace || process.cwd();
  let timer;
  try {
    const details = {};
    const work = (async () => {
      await client.start();
      await client.initialize();
      await client.newSession(workspaceDir);
      details.protocolVersion = client.protocolVersion ?? null;
      details.agentCapabilities = client.agentCapabilities ?? {};
      details.models = (client.sessionModels?.availableModels ?? []).map((m) => m?.modelId).filter(Boolean);
      details.currentModel = client.sessionModels?.currentModelId ?? null;
      details.modes = (client.sessionModes?.availableModes ?? []).map((m) => m?.id).filter(Boolean);
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { client.stop(); } catch {}
        reject(new Error(`Handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    await Promise.race([work, timeout]);
    return { ok: true, ...details };
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
  versionTimeoutMs = VERSION_PROBE_TIMEOUT_MS,
  readVersion = readPackageVersion,
} = {}) {
  const { capabilities, version } = getClientInfo();
  const agentProbe = await probeAgentVersion(spawnSpec, versionTimeoutMs);

  const out = {
    plugin: { version: readVersion() },
    client: {
      name: version?.name ?? null,
      version: version?.version ?? null,
      capabilities: capabilities ?? {},
    },
    agent: {
      found: agentProbe.found,
      command: formatCommand(spawnSpec),
      version: agentProbe.version,
      ...(agentProbe.error ? { error: agentProbe.error } : {}),
    },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      transport: "stdio",
    },
    env: {
      ACP_LOG_SIZE: process.env.ACP_LOG_SIZE !== undefined ? process.env.ACP_LOG_SIZE : DEFAULT_LOG_SIZE,
      CURSOR_DELEGATE_TRANSCRIPT: process.env.CURSOR_DELEGATE_TRANSCRIPT ?? null,
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
