import { makeError } from "./errors.js";

export const DEFAULT_HARD_CAP_MS = 6 * 60 * 60 * 1000;

export class SessionSupervisor {
  constructor(client, {
    handshakeMs = 60000,
    hardCapMs = DEFAULT_HARD_CAP_MS,
    idleMs = 0,
  } = {}) {
    this.client = client;
    this.handshakeMs = handshakeMs;
    this.hardCapMs = hardCapMs;
    // Idle detection is opt-in: cursor-agent sends no frames while a shell command runs (26.9s of
    // silence measured for a healthy 20s command).
    this.idleMs = idleMs > 0 ? idleMs : 0;
    this.sessionId = null;
    this.lastActivityAt = Date.now();
    this._idleTimer = null;
    this._handshakeTimer = null;
    this._hardCapTimer = null;
    this._armed = false;
    this._settled = false;
    this._promptStarted = false;
    this._guardReject = null;
    this._onActivity = () => {
      this.lastActivityAt = Date.now();
      this._resetIdle();
    };
    this._onSetupCancel = () => this._trip("cancelled-in-setup", "cancelled before the prompt was sent");
    this._onExit = (info) => {
      this._trip(
        "agent-exit",
        // Kept whole, for the reason acp-client.js states where it builds the same message.
        `agent exited (code=${info.code}${info.signal ? ", signal=" + info.signal : ""})${info.stderr ? ": " + String(info.stderr) : ""}`
      );
    };
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

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

  // Silence in the request/response handshake means a wedged agent; once the prompt is in flight
  // it does not, so the deadline comes off.
  promptStarted() {
    if (this._promptStarted) return;
    this._promptStarted = true;
    clearTimeout(this._handshakeTimer);
    this._handshakeTimer = null;
    this._resetIdle();
  }

  disarm() {
    if (!this._armed) return;
    this._armed = false;
    this.client.off("activity", this._onActivity);
    this.client.off("exit", this._onExit);
    this.client.off("cancelled-in-setup", this._onSetupCancel);
    clearTimeout(this._idleTimer);
    clearTimeout(this._handshakeTimer);
    clearTimeout(this._hardCapTimer);
    this._idleTimer = null;
    this._handshakeTimer = null;
    this._hardCapTimer = null;
  }

  _resetIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (!this.idleMs || !this._promptStarted || !this._armed || this._settled) return;
    this._idleTimer = setTimeout(() => {
      this._trip("idle-timeout", `Session idle timeout after ${this.idleMs}ms`);
    }, this.idleMs);
  }

  abort() {
    this._trip("aborted", "delegation aborted by MCP host.");
  }

  _trip(reason, message) {
    if (this._settled) return;
    this._settled = true;
    this.disarm();
    const err = makeError(reason, message);
    if (reason === "idle-timeout" || reason === "handshake-timeout" || reason === "hard-cap" || reason === "aborted") {
      if (this.sessionId) { try { this.client.cancel(this.sessionId); } catch {} }
    }
    // Ended whether or not a session opened, so setup orphaned by this trip sends nothing more.
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
