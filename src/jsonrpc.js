import readline from "node:readline";

const FRAME_CAP = 2048;

export class JsonRpcPeer {
  constructor(input, output, { onNotification, onRequest, onActivity } = {}) {
    this.output = output;
    this.onNotification = onNotification || (() => {});
    this.onRequest = onRequest || (() => {});
    this.onActivity = onActivity || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    const rawSize = process.env.ACP_LOG_SIZE !== undefined ? Number(process.env.ACP_LOG_SIZE) : 2000;
    this._logSize = rawSize > 0 && !Number.isNaN(rawSize) ? rawSize : 0;
    this._log = [];
    this.rl = readline.createInterface({ input });
    this.rl.on("line", (line) => this._onLine(line));
  }

  _record(dir, line) {
    if (this._logSize <= 0) return;
    const truncated = line.length > FRAME_CAP ? line.slice(0, FRAME_CAP) : line;
    this._log.push({ t: Date.now(), dir, line: truncated });
    if (this._log.length > this._logSize) {
      this._log.splice(0, this._log.length - this._logSize);
    }
  }

  getLog() { return [...this._log]; }

  formatLog(n) {
    const entries = n !== undefined ? this._log.slice(-n) : this._log;
    return entries.map((e) => `${new Date(e.t).toISOString()} ${e.dir} ${e.line}`).join("\n");
  }

  _onLine(line) {
    this.onActivity();
    this._record("in", line);
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        // cursor-agent puts the actual reason in error.data.message; error.message alone
        // is a bare "Invalid params".
        if (msg.error) {
          const err = new Error([msg.error.message || "rpc error", msg.error.data?.message].filter(Boolean).join(": "));
          err.code = msg.error.code;
          p.reject(err);
        }
        else p.resolve(msg.result);
      }
    } else if (msg.method && hasId) {
      this.onRequest(msg.id, msg.method, msg.params);
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params);
    }
  }

  _write(obj) {
    const serialized = JSON.stringify(obj) + "\n";
    this._record("out", serialized);
    this.output.write(serialized);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) { this._write({ jsonrpc: "2.0", method, params }); }
  respond(id, result) { this._write({ jsonrpc: "2.0", id, result }); }
  respondError(id, code, message) { this._write({ jsonrpc: "2.0", id, error: { code, message } }); }

  rejectAllPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  close() { this.rl.close(); }
}
