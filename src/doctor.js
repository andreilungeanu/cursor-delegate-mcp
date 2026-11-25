import process from "node:process";
import { existsSync, statSync } from "node:fs";
import { AcpClient } from "./acp-client.js";
import { commandExists, resolveAcpSpawn } from "./spawn.js";
import { children, spawnChild, stopChild } from "./proc.js";
import { readPackageVersion } from "./version.js";
import { describeOptions } from "./model-options.js";
import { DEFAULT_MODEL } from "./delegate.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;

/** Reported when set: each changes how the agent is launched or how long a run may take. */
const ENV_KNOBS = ["ACP_AGENT_COMMAND", "ACP_AGENT_ARGS", "CURSOR_DELEGATE_TRANSCRIPT", "CURSOR_DELEGATE_HANDSHAKE_MS", "CURSOR_DELEGATE_HARD_CAP_MS"];

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

/**
 * Runs the launcher with cliArgs in place of the acp subcommand, so a launcher prefix
 * ("node index.js acp") still reaches the agent; with no acp token, cliArgs go alone. Time-boxed:
 * doctor runs when delegation is already broken, and a launcher that never answers must not hang it.
 * @param {{ command: string, args: string[], options?: any }} spawnSpec
 * @param {string[]} cliArgs
 * @param {number} timeoutMs
 * @param {{ signal?: AbortSignal, registry?: import("./proc.js").ChildRegistry, label?: string }} [opts]
 * @returns {Promise<{ found: boolean, code?: number | null, stdout?: string, error?: string }>}
 */
export function runAgentCli(spawnSpec, cliArgs, timeoutMs, { signal, registry = children, label = "probe" } = {}) {
  const { command, args, options } = spawnSpec;
  const launcher = String(command || "").replace(/^["']|["']$/g, "");
  const isJsScript = isJsLauncher(launcher);
  const execCommand = isJsScript ? process.execPath : command;
  const acpAt = Array.isArray(args) ? args.indexOf("acp") : -1;
  const fullArgs = [...(acpAt > 0 ? args.slice(0, acpAt) : []), ...cliArgs];
  const execArgs = isJsScript ? [launcher, ...fullArgs] : fullArgs;
  // Through a shell, a missing launcher still spawns (the shell does) and would read as found.
  if (options?.shell && !isJsScript && !commandExists(launcher, options.env)) return Promise.resolve({ found: false });
  const aborted = `${label} aborted by MCP host`;
  // Interrupted already, or shutting down: nothing is spawned, and found comes from the lookup alone.
  const notRun = (error) => Promise.resolve({ found: isJsScript ? existsSync(launcher) : commandExists(launcher, options?.env), error });
  if (signal?.aborted) return notRun(aborted);
  let child;
  try {
    child = spawnChild(execCommand, execArgs, options, { stdio: ["ignore", "pipe", "pipe"] }, registry);
  } catch (err) {
    return notRun(err.message);
  }
  return new Promise((resolve) => {
    let stdout = "";
    const finish = (result) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    // Drained: a full pipe blocks a noisy launcher, which would then read as a timeout.
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => {});
    child.on("error", () => finish({ found: false }));
    child.on("close", (code) => finish({ found: true, code, stdout }));
    // It spawned, so it is installed; it did not answer.
    const timer = setTimeout(() => {
      stopChild(child);
      finish({ found: true, error: `${label} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = () => {
      stopChild(child);
      finish({ found: true, error: aborted });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @param {{ command: string, args: string[], options?: any }} spawnSpec
 * @param {number} [timeoutMs]
 * @param {{ signal?: AbortSignal, registry?: import("./proc.js").ChildRegistry }} [opts]
 */
export async function probeAgentVersion(spawnSpec, timeoutMs = PROBE_TIMEOUT_MS, opts = {}) {
  const run = await runAgentCli(spawnSpec, ["--version"], timeoutMs, { ...opts, label: "version probe" });
  if (run.error) return { found: run.found, version: null, error: run.error };
  if (!run.found) return { found: false, version: null };
  return run.code === 0
    ? { found: true, version: run.stdout?.trim() || null }
    : { found: true, version: null, error: `version probe exited ${run.code}` };
}

function parseJson(run) {
  if (run.code !== 0 && !run.stdout) return null;
  try { return JSON.parse(run.stdout ?? ""); } catch { return null; }
}

/** `cursor-agent status` for the login and `about` for the plan and the latest CLI version. */
async function probeAccount(spawnSpec, timeoutMs, opts) {
  const [status, about] = await Promise.all([
    runAgentCli(spawnSpec, ["status", "--format", "json"], timeoutMs, opts).then(parseJson),
    runAgentCli(spawnSpec, ["about", "--format", "json"], timeoutMs, opts).then(parseJson),
  ]);
  const signedIn = status?.isAuthenticated;
  return {
    auth: {
      status: signedIn === true ? "ok" : signedIn === false ? "logged-out" : "unknown",
      ...(typeof about?.subscriptionTier === "string" ? { plan: about.subscriptionTier } : {}),
    },
    // Both from about, so a version string format of its own does not read as an update.
    latestVersion: typeof about?.latestVersion === "string" && typeof about?.cliVersion === "string"
      && about.latestVersion !== about.cliVersion ? about.latestVersion : null,
  };
}

function describeWorkspace(workspace, warnings) {
  let stat = null;
  try { stat = statSync(workspace); } catch {}
  const out = { path: workspace, exists: Boolean(stat), isDirectory: Boolean(stat?.isDirectory()) };
  if (!out.exists) warnings.push(`workspace does not exist: ${workspace}`);
  else if (!out.isDirectory) warnings.push(`workspace is not a directory: ${workspace}`);
  return out;
}

async function runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs, signal }) {
  if (signal?.aborted) return { session: { ok: false, error: "Handshake aborted by MCP host" } };
  const client = clientFactory({ spawnSpec });
  let timer;
  let onAbort;
  try {
    const work = (async () => {
      await client.start();
      await client.initialize();
      await client.newSession(workspace);
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
    const available = (client.sessionModels?.availableModels ?? []).map((m) => m?.modelId).filter((id) => typeof id === "string");
    return {
      session: { ok: true, modes: (client.sessionModes?.availableModes ?? []).map((m) => m?.id).filter(Boolean) },
      models: {
        default: DEFAULT_MODEL,
        // null when the agent listed nothing: delegate checks nothing then either.
        defaultAvailable: available.length ? available.includes(DEFAULT_MODEL) : null,
        current: client.sessionModels?.currentModelId ?? null,
        available,
        // From session/new, for the current model only (another needs a set_model). name and
        // category identify an unfamiliar effort option; currentValue is the model's saved level.
        currentModelOptions: describeOptions(client.configOptions),
      },
    };
  } catch (err) {
    return { session: { ok: false, error: err?.message || String(err) } };
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
 *   probeTimeoutMs?: number,
 *   readVersion?: () => string,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} [opts]
 */
export async function runDoctor({
  getClientInfo = () => ({ capabilities: {}, version: {} }),
  deep = false,
  spawnSpec = resolveAcpSpawn(),
  clientFactory = (opts) => new AcpClient(opts),
  workspace = process.cwd(),
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  readVersion = readPackageVersion,
  env = process.env,
  signal,
} = {}) {
  const { version, protocolVersion } = getClientInfo();
  /** @type {string[]} */
  const warnings = [];
  const probe = await probeAgentVersion(spawnSpec, probeTimeoutMs, { signal });

  /** @type {Record<string, any>} */
  let auth = { status: "unknown" };
  /** @type {string | null} */
  let latestVersion = null;
  if (!probe.found) {
    warnings.push("cursor-agent not found. Install the Cursor CLI and run `cursor-agent login`.");
  } else if (probe.version) {
    ({ auth, latestVersion } = await probeAccount(spawnSpec, probeTimeoutMs, { signal }));
    if (auth.status === "logged-out") warnings.push("cursor-agent is not logged in. Run `cursor-agent login`.");
  } else {
    warnings.push(`cursor-agent did not answer --version: ${probe.error}`);
  }

  const agent = {
    found: probe.found,
    command: formatCommand(spawnSpec),
    version: probe.version,
    ...(probe.error ? { error: probe.error } : {}),
    ...(latestVersion ? { latestVersion } : {}),
  };
  if (agent.latestVersion) warnings.push(`cursor-agent ${agent.latestVersion} is available. Run \`cursor-agent update\`.`);

  /** @type {Record<string, any>} */
  const out = {
    plugin: { name: "cursor-delegate-mcp", version: readVersion() },
    client: {
      name: version?.name ?? null,
      version: version?.version ?? null,
      // The MCP revision the host speaks: 2026-07-28 or a 2025-era one.
      ...(typeof protocolVersion === "string" ? { protocolVersion } : {}),
    },
    agent,
    auth,
    workspace: describeWorkspace(workspace, warnings),
  };
  const set = ENV_KNOBS.filter((name) => env[name] !== undefined);
  if (set.length) out.env = Object.fromEntries(set.map((name) => [name, env[name]]));
  out.warnings = warnings;

  if (deep) {
    const { session, models } = await runDeepHandshake({ spawnSpec, clientFactory, workspace, timeoutMs: handshakeTimeoutMs, signal });
    out.session = session;
    if (!session.ok) warnings.push(`The ACP handshake failed: ${session.error}`);
    if (models) {
      out.models = models;
      if (models.defaultAvailable === false) {
        warnings.push(`The default model ${DEFAULT_MODEL} is not among the models this account offers; a delegation that names no model fails with unknown-model.`);
      }
    }
  }

  return out;
}
