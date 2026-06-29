import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcPeer } from "./jsonrpc.js";
import { createRequestRouter } from "./request-router.js";
import { resolveAcpSpawn } from "./spawn.js";

const STDERR_CAP = 64 * 1024;

const VERSION = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
).version;

export class AcpClient extends EventEmitter {
  constructor({ spawnSpec, onElicit, mode, onCreatePlan } = {}) {
    super();
    this.spawnSpec = spawnSpec || resolveAcpSpawn();
    this.onElicit = onElicit;
    this.mode = mode;
    this.onCreatePlan = onCreatePlan;
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
      mode: this.mode,
      log: (e) => this.emit("ack", e),
    });
    return new Promise((resolve, reject) => {
      this.child.once("error", (e) =>
        reject(new Error(`Failed to spawn agent (${command}): ${e.message}. Install Cursor CLI and run 'agent login'.`)));
      this.child.once("spawn", () => resolve());
    });
  }

  initialize() { return this.peer.request("initialize", { protocolVersion: 1, clientInfo: { name: "cursor-delegate-mcp", version: VERSION }, clientCapabilities: { _meta: { parameterizedModelPicker: true } } }); }
  newSession(cwd) { return this.peer.request("session/new", { cwd, mcpServers: [] }); }
  loadSession(sessionId, cwd) { return this.peer.request("session/load", { sessionId, cwd, mcpServers: [] }); }
  setModel(sessionId, modelId) { return this.peer.request("session/set_model", { sessionId, modelId }); }
  setFast(sessionId, value) { return this.peer.request("session/set_config_option", { sessionId, configId: "fast", value }); } // configId, not optionId
  setMode(sessionId, modeId) { return this.peer.request("session/set_mode", { sessionId, modeId }); }
  prompt(sessionId, text) { return this.peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }); }
  cancel(sessionId) { this.peer.notify("session/cancel", { sessionId }); return Promise.resolve(); }

  getTranscript(n) { return this.peer ? this.peer.formatLog(n) : ""; }

  stop() { try { this.peer?.close(); } catch {} try { this.child?.kill(); } catch {} }
}
