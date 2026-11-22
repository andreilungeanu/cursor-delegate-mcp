import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { JsonRpcPeer } from "./jsonrpc.js";
import { createRequestRouter } from "./request-router.js";
import { commandExists, resolveAcpSpawn, shellArgv } from "./spawn.js";
import { DETACHED, isChildAlive, treeKill } from "./proc.js";
import { VERSION } from "./version.js";
import { makeError } from "./errors.js";

const STDERR_CAP = 64 * 1024;
// How long stop() waits for the exit after the kill. SIGKILL and taskkill /F land in milliseconds,
// so this elapses only when the kill failed.
const STOP_EXIT_TIMEOUT_MS = 2000;

export class AcpClient extends EventEmitter {
  /**
   * @param {{
   *   spawnSpec?: { command: string, args: string[], options?: object },
   *   mode?: string,
   *   onCreatePlan?: (body: any) => void,
   *   onTodos?: (body: any) => void,
   * }} [opts]
   */
  constructor({ spawnSpec, mode, onCreatePlan, onTodos } = {}) {
    super();
    this.spawnSpec = spawnSpec || resolveAcpSpawn();
    this.mode = mode;
    this.onCreatePlan = onCreatePlan;
    this.onTodos = onTodos;
    this._stderrChunks = [];
    this._stderrLength = 0;
    /** @type {Promise<boolean> | null} */
    this._stopping = null;
  }

  // The stderr tail an exit error quotes. Kept as chunks and joined on read, so a noisy agent costs
  // a push per chunk; a StringDecoder keeps a multi-byte character split across reads intact.
  // stderr is not ACP activity, so it does not feed the supervisor.
  get stderrBuffer() {
    const joined = this._stderrChunks.join("");
    return joined.length > STDERR_CAP ? joined.slice(-STDERR_CAP) : joined;
  }

  start() {
    const { command, args, options } = this.spawnSpec;
    const opts = /** @type {{ shell?: boolean, env?: NodeJS.ProcessEnv }} */ (options);
    if (opts?.shell && !commandExists(command, opts.env)) {
      return Promise.reject(makeError("spawn-failed", `Failed to spawn agent (${command}): not found on PATH. Install Cursor CLI and run 'cursor-agent login'.`));
    }
    this._stderrChunks = [];
    this._stderrLength = 0;
    const stderrDecoder = new StringDecoder("utf8");
    this._exitEmitted = false;
    const argv = shellArgv(command, args, opts);
    this.child = spawn(argv.command, argv.args, { ...options, detached: DETACHED, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk) => {
      const text = stderrDecoder.write(chunk);
      if (text) {
        this._stderrChunks.push(text);
        this._stderrLength += text.length;
        // Drop whole chunks from the front only once well past the cap, so the common case
        // costs one push. The joined tail is trimmed exactly on read.
        while (this._stderrChunks.length > 1 && this._stderrLength - this._stderrChunks[0].length >= STDERR_CAP) {
          this._stderrLength -= this._stderrChunks.shift().length;
        }
        // A single read larger than the cap (seen on GitHub Windows runners) is sliced too, so
        // retained memory stays bounded.
        const overflow = this._stderrLength - STDERR_CAP;
        if (overflow > 0) {
          this._stderrChunks[0] = this._stderrChunks[0].slice(overflow);
          this._stderrLength -= overflow;
        }
      }
    });
    this.child.stderr.on("error", () => {});
    // session/cancel can be written after the agent is gone, and an unhandled pipe 'error' would
    // take down the server. readline adds no handler on stdout either.
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    const emitExit = (code, signal) => {
      if (this._exitEmitted) return;
      this._exitEmitted = true;
      const stderr = this.stderrBuffer;
      const err = makeError(
        "agent-exit",
        // stderr whole, bounded by the 64KB buffer: why the agent died (a rejected model, a spent
        // quota, an expired login) can sit anywhere in it.
        `agent exited (code=${code}${signal ? ", signal=" + signal : ""})${stderr ? ": " + String(stderr) : ""}`
      );
      // exit + rejectAllPending both settle the same Promise.race; second rejection is intentional.
      this.peer?.rejectAllPending(err);
      this.emit("exit", { code, signal, stderr });
    };
    this.child.once("exit", emitExit);
    this.child.once("close", emitExit);
    this.router = null;
    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, {
      onNotification: (method, params) => {
        if (method === "session/update") this.emit("update", params);
        else if (method === "cursor/update_todos") {
          Promise.resolve(this.router?.(undefined, method, params)).catch(() => {});
        }
      },
      // The router is async and its result discarded, so a throw from its own catch would reject
      // unobserved and exit the process. Promise.resolve covers a sync router in tests.
      onRequest: (id, method, params) => {
        if (this.router) Promise.resolve(this.router(id, method, params)).catch(() => {});
      },
      onActivity: () => this.emit("activity"),
    });
    this.router = createRequestRouter({
      respond: (id, r) => this.peer.respond(id, r),
      respondError: (id, c, m) => this.peer.respondError(id, c, m),
      onCreatePlan: this.onCreatePlan,
      onTodos: this.onTodos,
      mode: this.mode,
      log: (e) => this.emit("ack", e),
    });
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this.child.once("error", (e) => {
        const err = makeError("spawn-failed", `Failed to spawn agent (${command}): ${e.message}. Install Cursor CLI and run 'cursor-agent login'.`);
        reject(err);
      });
      this.child.once("spawn", () => resolve());
    }));
  }

  // Stashed for the unknown-model check and doctor deep, so neither needs a second handshake.
  async initialize() {
    const res = await this.peer.request("initialize", { protocolVersion: 1, clientInfo: { name: "cursor-delegate-mcp", version: VERSION }, clientCapabilities: { _meta: { parameterizedModelPicker: true } } });
    this.protocolVersion = res?.protocolVersion;
    this.agentCapabilities = res?.agentCapabilities;
    return res;
  }
  _captureSession(res) {
    this.sessionModels = res?.models;
    this.sessionModes = res?.modes;
    this.configOptions = res?.configOptions;
    return res;
  }
  async newSession(cwd) { return this._captureSession(await this.peer.request("session/new", { cwd, mcpServers: [] })); }
  async loadSession(sessionId, cwd) { return this._captureSession(await this.peer.request("session/load", { sessionId, cwd, mcpServers: [] })); }
  setModel(sessionId, modelId) { return this.peer.request("session/set_model", { sessionId, modelId }); }
  setConfigOption(sessionId, configId, value) { return this.peer.request("session/set_config_option", { sessionId, configId, value: String(value) }); } // configId, not optionId; ACP wants a string value
  setMode(sessionId, modeId) { return this.peer.request("session/set_mode", { sessionId, modeId }); }
  prompt(sessionId, blocks) { return this.peer.request("session/prompt", { sessionId, prompt: blocks }); }
  cancel(sessionId) { this.peer.notify("session/cancel", { sessionId }); return Promise.resolve(); }

  getTranscript(n) { return this.peer ? this.peer.formatLog(n) : ""; }

  // Idempotent while teardown is in flight and after a confirmed exit. A missed exit is not
  // memoized — force retries with a new treeKill. A confirmed exit stays so later callers join.
  stop({ timeoutMs = STOP_EXIT_TIMEOUT_MS } = {}) {
    if (!this._stopping) {
      this._stopping = this._teardown(timeoutMs).then((observed) => {
        if (!observed) this._stopping = null;
        return observed;
      }, (err) => {
        this._stopping = null;
        throw err;
      });
    }
    return this._stopping;
  }

  async _teardown(timeoutMs) {
    const child = this.child;
    if (!child?.pid) {
      try { this.peer?.close(); } catch {}
      return true;
    }
    const alive = isChildAlive(child);
    // Subscribed before the kill, so an instant exit is not missed.
    const exited = alive
      ? /** @type {Promise<boolean>} */ (new Promise((resolve) => child.once("exit", () => resolve(true))))
      : Promise.resolve(true);
    // Runs for an exited child too: the agent can be gone while the commands it spawned are still
    // running, and on POSIX they stay in its process group, which is the only handle left on them.
    treeKill(child.pid, { childAlive: alive }).catch(() => {});
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const bounded = /** @type {Promise<boolean>} */ (new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }));
    const observed = await Promise.race([exited, bounded]);
    clearTimeout(timer);
    // On an observed exit, emitExit rejects in-flight RPCs with stderr, and racing it here would
    // drop that. Only a child still alive after the stop has its RPCs settled here.
    if (!observed && !this._exitEmitted && isChildAlive(child)) {
      try {
        this.peer?.rejectAllPending(makeError("agent-exit", "agent process did not exit after stop"));
      } catch {}
    }
    try { this.peer?.close(); } catch {}
    return observed;
  }
}
