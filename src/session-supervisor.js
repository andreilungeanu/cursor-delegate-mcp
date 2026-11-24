import { makeError } from "./errors.js";

export const DEFAULT_HARD_CAP_MS = 6 * 60 * 60 * 1000;

export class SessionSupervisor {
  constructor(client, {
    handshakeMs = 60000,
    hardCapMs = DEFAULT_HARD_CAP_MS,
  } = {}) {
    this.client = client;
    this.handshakeMs = handshakeMs;
    this.hardCapMs = hardCapMs;
    this.sessionId = null;
    this.lastActivityAt = Date.now();
    this._handshakeTimer = null;
    this._hardCapTimer = null;
    this._armed = false;
    this._settled = false;
    this._promptStarted = false;
    this._guardReject = null;
    this._onActivity = () => { this.lastActivityAt = Date.now(); };
    this._onSetupCancel = () => this._trip("cancelled-in-setup", "cancelled before the prompt was sent");
    this._onExit = (info) => {
      this._trip(
        "agent-exit",
        // stderr kept whole, as in acp-client.js.
        `agent exited (code=${info.code}${info.signal ? ", signal=" + info.signal : ""})${info.stderr ? ": " + String(info.stderr) : ""}`
      );
    };
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  // True once decided (a trip or the work's end); work still running after a trip reads it to stop.
  get settled() {
    return this._settled;
  }

  msSinceActivity() {
    return Date.now() - this.lastActivityAt;
  }

  arm() {
    if (this._armed) return;
    this._armed = true;
    this.client.on("activity", this._onActivity);
    this.client.on("exit", this._onExit);
    this.client.on("cancelled-in-setup", this._onSetupCancel);
    this._hardCapTimer = setTimeout(() => {
      this._trip("hard-cap", `Session hard-cap exceeded after ${this.hardCapMs}ms`);
    }, this.hardCapMs);
    this._handshakeTimer = setTimeout(() => {
      this._trip("handshake-timeout", `Agent handshake timeout after ${this.handshakeMs}ms (no prompt in flight)`);
    }, this.handshakeMs);
  }

  // Silence in the request/response handshake means a wedged agent; during the prompt it does not.
  promptStarted() {
    if (this._promptStarted) return;
    this._promptStarted = true;
    clearTimeout(this._handshakeTimer);
    this._handshakeTimer = null;
  }

  disarm() {
    if (!this._armed) return;
    this._armed = false;
    this.client.off("activity", this._onActivity);
    this.client.off("exit", this._onExit);
    this.client.off("cancelled-in-setup", this._onSetupCancel);
    clearTimeout(this._handshakeTimer);
    clearTimeout(this._hardCapTimer);
    this._handshakeTimer = null;
    this._hardCapTimer = null;
  }

  abort() {
    this._trip("aborted", "delegation aborted by MCP host.");
  }

  _trip(reason, message) {
    if (this._settled) return;
    this._settled = true;
    this.disarm();
    const err = makeError(reason, message);
    if (reason === "handshake-timeout" || reason === "hard-cap" || reason === "aborted") {
      if (this.sessionId) { try { this.client.cancel(this.sessionId); } catch {} }
    }
    // Closed whether or not a session opened, so setup orphaned by this trip cannot still prompt.
    try { this.client.endTurn?.(); } catch {}
    this._guardReject?.(err);
  }

  finish() {
    this.disarm();
  }

  supervise(work) {
    this.arm();
    const guard = new Promise((_, reject) => { this._guardReject = reject; });
    const run = Promise.resolve().then(work);
    return Promise.race([run, guard]).finally(() => {
      this._guardReject = null;
      if (!this._settled) {
        this._settled = true;
        this.disarm();
      }
    });
  }
}
