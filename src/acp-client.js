import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonRpcPeer } from "./jsonrpc.js";
import { createRequestRouter } from "./request-router.js";
import { resolveAcpSpawn } from "./spawn.js";
import { isChildAlive, treeKill } from "./proc.js";
import { VERSION } from "./version.js";

const STDERR_CAP = 64 * 1024;

export class AcpClient extends EventEmitter {
  constructor({ spawnSpec, onElicit, mode, onCreatePlan, onTodos } = {}) {
    super();
    this.spawnSpec = spawnSpec || resolveAcpSpawn();
    this.onElicit = onElicit;
    this.mode = mode;
    this.onCreatePlan = onCreatePlan;
    this.onTodos = onTodos;
  }

  start() {
    const { command, args, options } = this.spawnSpec;
    this.stderrBuffer = "";
    this._exitEmitted = false;
    this.child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-STDERR_CAP);
      this.emit("activity");
    });
    this.child.stderr.on("error", () => {});
    const emitExit = (code, signal) => {
      if (this._exitEmitted) return;
      this._exitEmitted = true;
      const stderr = this.stderrBuffer;
      const err = new Error(
        `agent exited (code=${code}${signal ? ", signal=" + signal : ""})${stderr ? ": " + String(stderr).slice(-2000) : ""}`
      );
      err.reason = "agent-exit";
      // exit + rejectAllPending both settle the same Promise.race; second rejection is intentional.
      this.peer?.rejectAllPending(err);
      this.emit("exit", { code, signal, stderr });
    };
    this.child.once("exit", emitExit);
    this.child.once("close", emitExit);
    this.router = null; // set before first stdout line
    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, {
      onNotification: (method, params) => { if (method === "session/update") this.emit("update", params); },
      onRequest: (id, method, params) => this.router && this.router(id, method, params),
      onActivity: () => this.emit("activity"),
    });
    this.router = createRequestRouter({
      respond: (id, r) => this.peer.respond(id, r),
      respondError: (id, c, m) => this.peer.respondError(id, c, m),
      onElicit: this.onElicit,
      onCreatePlan: this.onCreatePlan,
      onTodos: this.onTodos,
      mode: this.mode,
      log: (e) => this.emit("ack", e),
    });
    return new Promise((resolve, reject) => {
      this.child.once("error", (e) =>
        reject(new Error(`Failed to spawn agent (${command}): ${e.message}. Install Cursor CLI and run 'cursor-agent login'.`)));
      this.child.once("spawn", () => resolve());
    });
  }

  // The handshake replies carry the agent's live capabilities, model list and mode list.
  // Keep them; every caller still gets the reply unchanged.
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
  setFast(sessionId, value) { return this.peer.request("session/set_config_option", { sessionId, configId: "fast", value: String(value) }); } // configId, not optionId; ACP wants a string value
  setMode(sessionId, modeId) { return this.peer.request("session/set_mode", { sessionId, modeId }); }
  prompt(sessionId, text) { return this.peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }); }
  cancel(sessionId) { this.peer.notify("session/cancel", { sessionId }); return Promise.resolve(); }

  getTranscript(n) { return this.peer ? this.peer.formatLog(n) : ""; }

  stop() {
    try { this.peer?.close(); } catch {}
    if (isChildAlive(this.child) && this.child.pid) {
      treeKill(this.child.pid).catch(() => {});
    } else {
      try { this.child?.kill(); } catch {}
    }
  }
}
