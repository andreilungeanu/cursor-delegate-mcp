import process from "node:process";
import { existsSync } from "node:fs";
import { AcpClient } from "./acp-client.js";
import { commandExists, resolveAcpSpawn } from "./spawn.js";
import { children, spawnChild } from "./proc.js";
import { readPackageVersion } from "./version.js";
import { describeOptions } from "./model-options.js";

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

// Time-boxed, like the deep handshake: doctor runs when delegation is already broken, and a
// launcher that never answers must not hang it.
/**
 * @param {{ command: string, args: string[], options?: any }} spawnSpec
 * @param {number} [timeoutMs]
 * @param {{ signal?: AbortSignal, registry?: import("./proc.js").ChildRegistry }} [opts]
 */
export function probeAgentVersion(spawnSpec, timeoutMs = VERSION_PROBE_TIMEOUT_MS, { signal, registry = children } = {}) {
  const { command, args, options } = spawnSpec;
  const launcher = String(command || "").replace(/^["']|["']$/g, "");
  const isJsScript = isJsLauncher(launcher);
  const execCommand = isJsScript ? process.execPath : command;
  // --version replaces the acp subcommand, so a launcher prefix ("node index.js acp") still
  // reaches the agent. With no acp token, --version goes alone.
  const acpAt = Array.isArray(args) ? args.indexOf("acp") : -1;
  const versionArgs = [...(acpAt > 0 ? args.slice(0, acpAt) : []), "--version"];
  const execArgs = isJsScript ? [launcher, ...versionArgs] : versionArgs;
  // Through a shell, a missing launcher still spawns (the shell does) and would read as found.
  if (options?.shell && !isJsScript && !commandExists(launcher, options.env)) return Promise.resolve({ found: false, version: null });
  const aborted = { version: null, error: "version probe aborted by MCP host" };
  // Interrupted already, or shutting down: nothing is spawned, and found comes from the lookup alone.
  const notRun = (error) => Promise.resolve({ found: isJsScript ? existsSync(launcher) : commandExists(launcher, options?.env), version: null, error });
  if (signal?.aborted) return notRun(aborted.error);
  let probe;
  try {
    probe = spawnChild(execCommand, execArgs, options, { stdio: ["ignore", "pipe", "pipe"] }, registry);
  } catch (err) {
    return notRun(err.message);
  }
  const { child } = probe;
  return new Promise((resolve) => {
    let settled = false;
    let aborting = false;
    let stdout = "";
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // Settles once the stop saw the probe exit, so doctor does not return with it running.
    const onAbort = () => {
      // Else it fires during the kill and reports a timeout.
      clearTimeout(timer);
      aborting = true;
      probe.stop().then(() => finish({ found: true, ...aborted }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Capped: a version is one line, and a launcher that streams is not kept whole.
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < PROBE_STDOUT_CAP) stdout += chunk.toString();
    });
    // Drained: a full stderr pipe blocks the launcher, and a noisy one would read as wedged.
    child.stderr?.on("data", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", () => finish({ found: false, version: null }));
    child.on("close", (code) => {
      // Closed: its pid may be reused, so no later stop may kill it.
      probe.release();
      // An aborted probe reports the abort, not the exit its kill caused.
      if (aborting) return;
      const version = code === 0 ? stdout.trim() || null : null;
      finish({
        found: true,
        version,
        ...(code !== 0 ? { error: `version probe exited ${code}` } : {}),
      });
    });
    timer = setTimeout(() => {
      // Not awaited, so the timeout returns on time; the probe stays tracked until its stop settles.
      probe.stop();
      // It spawned, so it is found; it just never answered.
      finish({ found: true, version: null, error: `version probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs, signal }) {
  if (signal?.aborted) return { ok: false, error: "Handshake aborted by MCP host" };
  const client = clientFactory({ spawnSpec });
  const workspaceDir = workspace || process.cwd();
  let timer;
  let onAbort;
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
      // From session/new, for the current model only (another needs a set_model). name and
      // category identify an unfamiliar effort option; currentValue is the model's saved level.
      details.currentModelOptions = describeOptions(client.configOptions);
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Not awaited, so the timeout rejects on its deadline; the finally awaits the same stop.
        try { Promise.resolve(client.stop()).catch(() => {}); } catch {}
        reject(new Error(`Handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        try { Promise.resolve(client.stop()).catch(() => {}); } catch {}
        reject(new Error("Handshake aborted by MCP host"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([work, timeout, aborted]);
    return { ok: true, ...details };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Awaited so doctor does not return with its agent still alive; a killed child exits in ms.
    try { await Promise.resolve(client.stop()); } catch {}
  }
}

/**
 * @param {{
 *   getClientInfo?: () => { capabilities?: any, version?: any, protocolVersion?: string },
 *   deep?: boolean,
 *   spawnSpec?: { command: string, args: string[], options?: object },
 *   clientFactory?: (opts: any) => any,
 *   workspace?: string,
 *   handshakeTimeoutMs?: number,
 *   versionTimeoutMs?: number,
 *   readVersion?: () => string,
 *   signal?: AbortSignal,
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
  signal,
} = {}) {
  const { capabilities, version, protocolVersion } = getClientInfo();
  const agentProbe = await probeAgentVersion(spawnSpec, versionTimeoutMs, { signal });

  /** @type {{ plugin: any, client: any, agent: any & { handshake?: any }, runtime: any, env: any }} */
  const out = {
    plugin: { version: readVersion() },
    client: {
      name: version?.name ?? null,
      version: version?.version ?? null,
      capabilities: capabilities ?? {},
      // The MCP revision the host speaks: 2026-07-28 or a 2025-era one.
      ...(typeof protocolVersion === "string" ? { protocolVersion } : {}),
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
      signal,
    });
  }

  return out;
}
