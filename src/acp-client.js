import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { JsonRpcPeer } from "./jsonrpc.js";
import { createRequestRouter } from "./request-router.js";
import { resolveAcpSpawn } from "./spawn.js";
import { DETACHED, isChildAlive, treeKill } from "./proc.js";
import { VERSION } from "./version.js";
import { makeError } from "./errors.js";

const STDERR_CAP = 64 * 1024;
// How long stop() waits for the child to actually exit after the kill is dispatched. SIGKILL and
// taskkill /F land in milliseconds, so this only ever elapses when the kill did not work.
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

  // stderr is captured but does not count as activity: the supervisor measures ACP frames, and
  // an agent writing diagnostics is not the same fact as a turn making progress.
  // The tail of stderr, which is what an exit error quotes. Kept as chunks and joined on read:
  // rebuilding a 64KB string per chunk was the whole cost of a noisy agent. A StringDecoder
  // holds partial UTF-8 across chunk boundaries, so a multi-byte character split by the pipe
  // does not land in the error message as a replacement char.
  get stderrBuffer() {
    const joined = this._stderrChunks.join("");
    return joined.length > STDERR_CAP ? joined.slice(-STDERR_CAP) : joined;
  }

  start() {
    const { command, args, options } = this.spawnSpec;
    this._stderrChunks = [];
    this._stderrLength = 0;
    const stderrDecoder = new StringDecoder("utf8");
    this._exitEmitted = false;
    this.child = spawn(command, args, { ...options, detached: DETACHED, stdio: ["pipe", "pipe", "pipe"] });
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
        // Whole-chunk drops leave a remainder when one pipe read is itself larger than the cap
        // (observed on GitHub Windows runners). Slice that first chunk so retained memory cannot
        // grow with the flood; the public tail is still exactly one cap on read.
        const overflow = this._stderrLength - STDERR_CAP;
        if (overflow > 0) {
          this._stderrChunks[0] = this._stderrChunks[0].slice(overflow);
          this._stderrLength -= overflow;
        }
      }
    });
    this.child.stderr.on("error", () => {});
    // A supervisor trip writes session/cancel, which can land after the agent is already gone.
    // Without a handler that surfaces as an unhandled 'error' event on some platforms, taking
    // the whole MCP server down with it. stdout needs the same guard; readline adds none.
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    const emitExit = (code, signal) => {
      if (this._exitEmitted) return;
      this._exitEmitted = true;
      const stderr = this.stderrBuffer;
      const err = makeError(
        "agent-exit",
        // stderr kept whole. This is the one string that says why the agent died — the model
        // that was rejected, the quota that ran out, the login that expired — and the part that
        // names it can sit anywhere in it. The 64KB ring buffer above is the bound.
        `agent exited (code=${code}${signal ? ", signal=" + signal : ""})${stderr ? ": " + String(stderr) : ""}`
      );
      // exit + rejectAllPending both settle the same Promise.race; second rejection is intentional.
      this.peer?.rejectAllPending(err);
      this.emit("exit", { code, signal, stderr });
    };
    this.child.once("exit", emitExit);
    this.child.once("close", emitExit);
    this.router = null; // set before first stdout line
    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, {
      onNotification: (method, params) => { if (method === "session/update") this.emit("update", params); },
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
        // Tagged like every other failure class so the caller gets
        // "delegate failed [spawn-failed]: ..." instead of the one untagged prose error.
        const err = makeError("spawn-failed", `Failed to spawn agent (${command}): ${e.message}. Install Cursor CLI and run 'cursor-agent login'.`);
        reject(err);
      });
      this.child.once("spawn", () => resolve());
    }));
  }

  // Stashed so the unknown-model pre-flight and doctor --deep can read the agent's real
  // capability and model lists without paying for a second handshake.
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

  // Idempotent while a teardown is in flight and after a confirmed exit, so a force-cancel
  // racing the delegation's own finally tears down once. A missed exit is not the same
  // fact as the process being gone: that result is not memoized, and force can retry.
  stop({ timeoutMs = STOP_EXIT_TIMEOUT_MS } = {}) {
    if (!this._stopping) {
      this._stopping = this._teardown(timeoutMs).then((observed) => {
        // A missed exit must not poison later force-kills: the documented retry is a new
        // treeKill, not the same false. A confirmed exit stays memoized so concurrent and
        // later callers still join one teardown.
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
    // Subscribed before the kill is dispatched. A child that dies immediately would otherwise
    // exit in the gap and leave this waiting on an event that has already fired.
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
    // Pending RPCs are left to the exit handler, which rejects them with agent-exit. Rejecting
    // them here too would settle the same promises twice for no new information.
    try { this.peer?.close(); } catch {}
    return observed;
  }
}
