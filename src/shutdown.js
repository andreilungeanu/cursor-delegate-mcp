import process from "node:process";

/**
 * Runs stopAll, then exits, on any way the host has of going away: SIGINT, SIGTERM, SIGHUP, stdin
 * EOF, or the returned function. Only a second signal exits without waiting.
 * @param {() => Promise<unknown>} stopAll
 * @param {{ exit?: (code: number) => void, stdin?: NodeJS.EventEmitter }} [opts]
 * @returns {() => void}
 */
export function installSignalCleanup(stopAll, { exit = (code) => process.exit(code), stdin = process.stdin } = {}) {
  let stopping = false;
  let signals = 0;
  /** @param {number} code @param {boolean} [fromSignal] */
  const shutdown = (code, fromSignal = false) => {
    // A hangup closes stdin and sends SIGHUP, in either order.
    if (fromSignal && ++signals > 1) return exit(code);
    if (stopping) return;
    stopping = true;
    // Waits for the kills: on Windows taskkill is a separate process, and exiting first leaves the
    // agent running (measured). Each stop is bounded.
    Promise.resolve().then(stopAll).catch(() => {}).finally(() => exit(code));
  };
  // Replaces Node's default exit on a signal, which on POSIX never reaches agents in groups of their own.
  for (const [signal, code] of /** @type {[NodeJS.Signals, number][]} */ ([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]])) {
    process.on(signal, () => shutdown(code, true));
  }
  stdin.on("end", () => shutdown(0));
  return () => shutdown(0);
}
