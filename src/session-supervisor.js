function makeError(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

export class SessionSupervisor {
  constructor(client, {
    handshakeMs = 60000,
    hardCapMs = 3600000,
    idleMs = 0,
  } = {}) {
    this.client = client;
    this.handshakeMs = handshakeMs;
    this.hardCapMs = hardCapMs;
    // Mid-turn idle detection is opt-in and off by default. cursor-agent emits no ACP
    // frames while a shell command runs, so silence during a prompt turn says nothing
    // about liveness: a probe measured 26.9s of dead wire for a healthy 20s command.
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
    this._onExit = (info) => {
      this._trip(
        "agent-exit",
        `agent exited (code=${info.code}${info.signal ? ", signal=" + info.signal : ""})${info.stderr ? ": " + String(info.stderr).slice(-2000) : ""}`
      );
    };
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  msSinceActivity() {
    return Date.now() - this.lastActivityAt;
  }

  arm() {
    if (this._armed) return;
    this._armed = true;
    this.client.on("activity", this._onActivity);
    this.client.on("exit", this._onExit);
    this._hardCapTimer = setTimeout(() => {
      this._trip("hard-cap", `Session hard-cap exceeded after ${this.hardCapMs}ms`);
    }, this.hardCapMs);
    this._handshakeTimer = setTimeout(() => {
      this._trip("handshake-timeout", `Agent handshake timeout after ${this.handshakeMs}ms (no prompt in flight)`);
    }, this.handshakeMs);
  }

  // The handshake is strict request/response, so silence there is real evidence of a
  // wedged agent. Once the prompt is in flight that stops being true, and the deadline
  // must come off.
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
    this._trip("aborted", "delegation aborted by MCP host");
  }

  _trip(reason, message) {
    if (this._settled) return;
    this._settled = true;
    this.disarm();
    const err = makeError(reason, message);
    if (reason === "idle-timeout" || reason === "handshake-timeout" || reason === "hard-cap" || reason === "aborted") {
      if (this.sessionId) { try { this.client.cancel(this.sessionId); } catch {} }
    }
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
