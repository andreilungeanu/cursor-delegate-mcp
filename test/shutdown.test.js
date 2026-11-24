import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { installSignalCleanup } from "../src/shutdown.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const tick = () => new Promise((resolve) => setImmediate(resolve));

// installSignalCleanup with a stopAll the test settles. Its signal handlers are called directly and
// removed by done(), so no real signal reaches the test runner.
function install() {
  const before = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
  const stdin = new EventEmitter();
  const exits = [];
  let stops = 0;
  let settle = { resolve: () => {}, reject: (_err) => {} };
  const hostGone = installSignalCleanup(() => {
    stops++;
    return new Promise((resolve, reject) => { settle = { resolve, reject }; });
  }, { exit: (code) => { exits.push(code); }, stdin });
  const added = (signal) => process.listeners(signal).filter((listener) => !before.get(signal).includes(listener));
  const handlers = new Map(SIGNALS.map((signal) => [signal, added(signal)]));
  return {
    stdin, exits, hostGone, settle: () => settle,
    stops: () => stops,
    signal: (name) => { for (const listener of handlers.get(name)) listener(); },
    done: () => { for (const signal of SIGNALS) for (const listener of handlers.get(signal)) process.removeListener(signal, listener); },
  };
}

test("stdin EOF runs stopAll once and exits 0 when it settles", async () => {
  const h = install();
  try {
    h.stdin.emit("end");
    h.hostGone();
    await tick();
    assert.equal(h.stops(), 1);
    assert.deepEqual(h.exits, [], "exited before the kills settled");
    h.settle().resolve();
    await tick();
    assert.deepEqual(h.exits, [0]);
  } finally {
    h.done();
  }
});

test("a signal exits with its code once stopAll settles, and a second signal exits at once", async () => {
  const h = install();
  try {
    h.signal("SIGTERM");
    await tick();
    assert.deepEqual(h.exits, []);
    h.signal("SIGINT");
    assert.deepEqual(h.exits, [130]);
    assert.equal(h.stops(), 1);
  } finally {
    h.done();
  }
});

test("a stdin EOF and the hangup signal that follows it wait for the kills", async () => {
  const h = install();
  try {
    h.stdin.emit("end");
    h.signal("SIGHUP");
    await tick();
    assert.deepEqual(h.exits, []);
    h.settle().resolve();
    await tick();
    assert.deepEqual(h.exits, [0]);
  } finally {
    h.done();
  }
});

test("a stopAll that rejects still exits", async () => {
  const h = install();
  try {
    h.stdin.emit("end");
    await tick();
    h.settle().reject(new Error("kill failed"));
    await tick();
    assert.deepEqual(h.exits, [0]);
  } finally {
    h.done();
  }
});
