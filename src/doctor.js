import process from "node:process";
import { spawn } from "node:child_process";
import { AcpClient } from "./acp-client.js";
import { resolveAcpSpawn } from "./spawn.js";
import { DETACHED, treeKill } from "./proc.js";
import { readPackageVersion } from "./version.js";
import { allowedValues } from "./model-options.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const PROBE_STDOUT_CAP = 64 * 1024;
const DEFAULT_LOG_SIZE = "2000";

function formatArg(value) {
  const s = String(value);
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function formatCommand({ command, args }) {
  const bits = [formatArg(command), ...(args || []).map(formatArg)];
  return args?.length ? bits.join(" ") : formatArg(command);
}

function isJsLauncher(command) {
  const trimmed = String(command || "").replace(/^["']|["']$/g, "");
  return /\.(?:cjs|mjs|js)$/i.test(trimmed);
}

function envReport(name, fallback = null) {
  return process.env[name] !== undefined ? process.env[name] : fallback;
}

// Time-boxed because a launcher that accepts --version and then never answers would hang doctor
// forever — and doctor is what you run when delegation is already broken, so a wedged agent is
// exactly the case it must survive. Same guard the deep handshake has.
export function probeAgentVersion(spawnSpec, timeoutMs = VERSION_PROBE_TIMEOUT_MS) {
  const { command, options } = spawnSpec;
  const launcher = String(command || "").replace(/^["']|["']$/g, "");
  const isJsScript = isJsLauncher(launcher);
  const execCommand = isJsScript ? process.execPath : command;
  const execArgs = isJsScript ? [launcher, "--version"] : ["--version"];
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
    const child = spawn(execCommand, execArgs, { ...options, detached: DETACHED, stdio: ["ignore", "pipe", "pipe"] });
    // Capped: a version string is a line, and a launcher that streams instead should not be
    // accumulated whole while the probe waits out its timeout.
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < PROBE_STDOUT_CAP) stdout += chunk.toString();
    });
    // Drained, not merely piped. An unread pipe fills, the launcher blocks writing to it and so
    // never exits, and the probe can only report that as a timeout — a healthy but noisy
    // launcher reads out identically to a wedged one. Nothing consumes the bytes.
    child.stderr?.on("data", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", () => finish({ found: false, version: null }));
    child.on("close", (code) => {
      const version = code === 0 ? stdout.trim() || null : null;
      finish({
        found: true,
        version,
        ...(code !== 0 ? { error: `version probe exited ${code}` } : {}),
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
      // session/new already returned these. currentModel only — any other model needs a set_model
      // first, which this handshake does not send.
      details.currentModelOptions = (client.configOptions ?? [])
        .filter((o) => typeof o?.id === "string" && o.id !== "model" && o.id !== "mode")
        .map((o) => ({ id: o.id, values: allowedValues(o) }));
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Not awaited, so the timeout still rejects at its stated deadline rather than at the
        // deadline plus teardown. The finally below awaits the same idempotent promise.
        try { Promise.resolve(client.stop()).catch(() => {}); } catch {}
        reject(new Error(`Handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    await Promise.race([work, timeout]);
    return { ok: true, ...details };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
    // Awaited so doctor does not return while the agent it spawned is still being torn down.
    // A killed child exits in milliseconds; only one that ignores the kill costs the full bound.
    try { await Promise.resolve(client.stop()); } catch {}
  }
}

/**
 * @param {{
 *   getClientInfo?: () => { capabilities?: any, version?: any },
 *   deep?: boolean,
 *   spawnSpec?: { command: string, args: string[], options?: object },
 *   clientFactory?: (opts: any) => any,
 *   workspace?: string,
 *   handshakeTimeoutMs?: number,
 *   versionTimeoutMs?: number,
 *   readVersion?: () => string,
 * }} [opts]
 */
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

  /** @type {{ plugin: any, client: any, agent: any & { handshake?: any }, runtime: any, env: any }} */
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
      ACP_LOG_SIZE: envReport("ACP_LOG_SIZE", DEFAULT_LOG_SIZE),
      ACP_AGENT_COMMAND: envReport("ACP_AGENT_COMMAND"),
      ACP_AGENT_ARGS: envReport("ACP_AGENT_ARGS"),
      CURSOR_DELEGATE_TRANSCRIPT: envReport("CURSOR_DELEGATE_TRANSCRIPT"),
      CURSOR_DELEGATE_HANDSHAKE_MS: envReport("CURSOR_DELEGATE_HANDSHAKE_MS"),
      CURSOR_DELEGATE_HARD_CAP_MS: envReport("CURSOR_DELEGATE_HARD_CAP_MS"),
      CURSOR_DELEGATE_IDLE_MS: envReport("CURSOR_DELEGATE_IDLE_MS"),
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
