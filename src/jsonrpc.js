import readline from "node:readline";

const FRAME_CAP = 2048;
const DEFAULT_LOG_SIZE = 2000;

function readLogSize(raw) {
  if (raw === undefined) return DEFAULT_LOG_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOG_SIZE;
  return Math.floor(n);
}

// Frames of transcript CURSOR_DELEGATE_TRANSCRIPT asks for. Unset or blank means none and a
// number is the count (0 = none); anything unparseable reads as on at the default depth, the
// same policy readLogSize applies to ACP_LOG_SIZE — "true" and "yes" are natural things to set,
// and silently disabling the transcript on them is the opposite of what the setter wanted.
export function transcriptFrames(raw = process.env.CURSOR_DELEGATE_TRANSCRIPT) {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LOG_SIZE;
  return Math.max(0, Math.floor(n));
}

export class JsonRpcPeer {
  /**
   * @param {import("node:stream").Readable} input
   * @param {import("node:stream").Writable} output
   * @param {{
   *   onNotification?: (method: string, params: any) => void,
   *   onRequest?: (id: any, method: string, params: any) => void,
   *   onActivity?: () => void,
   * }} handlers
   */
  constructor(input, output, { onNotification, onRequest, onActivity } = {}) {
    this.output = output;
    this.onNotification = onNotification || (() => {});
    this.onRequest = onRequest || (() => {});
    this.onActivity = onActivity || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    // 0 disables recording and is documented; anything unparseable is a typo, and silently
    // disabling the transcript on a typo is the opposite of what the setter wanted.
    this._logSize = readLogSize(process.env.ACP_LOG_SIZE);
    // The failure transcript is the only thing that reads these frames, and it is opt-in, so
    // recording by default retained up to _logSize × FRAME_CAP bytes per delegation that nothing
    // would ever ask for. ACP_LOG_SIZE still bounds retention and still disables at 0.
    this._recording = this._logSize > 0 && transcriptFrames() > 0;
    this._log = [];
    this.rl = readline.createInterface({ input });
    // The interface re-emits the input stream's error as its own, so the handler acp-client.js
    // puts on the child's stdout does not cover this one: an unhandled 'error' here is an
    // uncaught exception, which takes down the server and every concurrent delegation with it.
    this.rl.on("error", () => {});
    this.rl.on("line", (line) => this._onLine(line));
  }

  // Trimming to the cap on every frame meant shifting a 2000-entry array per frame, which on a
  // chatty turn cost more than parsing the frames. Let the array overshoot by a quarter and trim
  // in one batch; readers below take the last _logSize, so what the log reports is unchanged.
  _record(dir, line) {
    if (!this._recording) return;
    const truncated = line.length > FRAME_CAP ? line.slice(0, FRAME_CAP) : line;
    this._log.push({ t: Date.now(), dir, line: truncated });
    if (this._log.length > this._logSize + (this._logSize >> 2)) {
      this._log = this._log.slice(-this._logSize);
    }
  }

  _entries() {
    return this._log.length > this._logSize ? this._log.slice(-this._logSize) : this._log;
  }

  getLog() { return [...this._entries()]; }

  formatLog(n) {
    const entries = n !== undefined ? this._entries().slice(-n) : this._entries();
    return entries.map((e) => `${new Date(e.t).toISOString()} ${e.dir} ${e.line}`).join("\n");
  }

  _onLine(line) {
    this._record("in", line);
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // Only a parsed frame counts. A blank line, a launcher banner or anything else the agent
    // prints is not the protocol advancing, and treating it as such is what let a chatty
    // launcher hold the idle guard open and made "Last ACP frame Ns ago" report a stderr byte.
    this.onActivity();
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      // Keyed by string: a peer that echoes "1" for the id 1 is still answering that request,
      // and matching by identity left it pending until a timeout fired an hour later.
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        // cursor-agent puts the actual reason in error.data.message; error.message alone
        // is a bare "Invalid params".
        if (msg.error) {
          /** @type {import("./errors.js").DelegateError} */
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
      this.pending.set(String(id), { resolve, reject });
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
