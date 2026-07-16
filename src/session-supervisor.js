import { isChildAlive, treeKill } from "./proc.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeError(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

export class SessionSupervisor {
  constructor(client, {
    idleMs = 90000,
    hardCapMs = 3600000,
    cancelGraceMs = 10000,
    killGraceMs = 5000,
  } = {}) {
    this.client = client;
    this.idleMs = idleMs;
    this.hardCapMs = hardCapMs;
    this.cancelGraceMs = cancelGraceMs;
    this.killGraceMs = killGraceMs;
    this.sessionId = null;
    this._idleTimer = null;
    this._hardCapTimer = null;
    this._armed = false;
    this._settled = false;
    this._escalation = null;
    this._guardReject = null;
    this._onActivity = () => this._resetIdle();
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

  arm() {
    if (this._armed) return;
    this._armed = true;
    this.client.on("activity", this._onActivity);
    this.client.on("exit", this._onExit);
    this._hardCapTimer = setTimeout(() => {
      this._trip("hard-cap", `Session hard-cap exceeded after ${this.hardCapMs}ms`);
    }, this.hardCapMs);
    this._resetIdle();
  }

  disarm() {
    if (!this._armed) return;
    this._armed = false;
    this.client.off("activity", this._onActivity);
    this.client.off("exit", this._onExit);
    clearTimeout(this._idleTimer);
    clearTimeout(this._hardCapTimer);
    this._idleTimer = null;
    this._hardCapTimer = null;
  }

  _resetIdle() {
    clearTimeout(this._idleTimer);
    if (!this._armed || this._settled) return;
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
    if (reason === "idle-timeout" || reason === "hard-cap" || reason === "aborted") {
      if (!this._escalation) this._escalation = this._runEscalation();
    }
    this._guardReject?.(err);
  }

  async _runEscalation() {
    const { client, sessionId } = this;
    if (sessionId) {
      try { await client.cancel(sessionId); } catch {}
      await sleep(this.cancelGraceMs);
    }
    const child = client.child;
    if (!isChildAlive(child)) return;
    try { child.kill(); } catch {}
    await sleep(this.killGraceMs);
    if (!isChildAlive(child)) return;
    const pid = child.pid;
    if (pid) await treeKill(pid);
  }

  finish() {
    this._escalation?.catch(() => {});
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
