import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { installSignalCleanup } from "../src/server.js";
import { createChildRegistry } from "../src/proc.js";

// Signals are handled on POSIX only, where each agent has its own process group.
const SIGNAL_CODES = process.platform === "win32" ? {} : { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
const OUTCOMES = ["true", "false", "reject"];
const CHILDREN = ["agent", "probe"];

// A tracked child whose kill attempts the explorer settles. Its exit is an event of its own, and an
// attempt sees it (true) only after it.
function fakeChild(name, registry) {
  const c = { name, attempts: [], exited: false, confirmed: false, child: new EventEmitter() };
  registry.track(() => ({
    child: c.child,
    kill: () => {
      let settle;
      const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      c.attempts.push({ settle, outcome: null });
      return result;
    },
  }));
  return c;
}

async function replay(choices) {
  const world = { exit: null, codes: [], signals: [], eof: false, scheduled: [], inScheduled: false, rejections: [], violations: [], lateTried: false, lateSpawned: false };
  const registry = createChildRegistry();
  const kids = CHILDREN.map((name) => fakeChild(name, registry));
  const onRejection = (err) => world.rejections.push(err);
  process.on("unhandledRejection", onRejection);
  const before = Object.fromEntries(Object.keys(SIGNAL_CODES).map((s) => [s, process.listeners(s)]));
  const expectedSoFar = () => (world.signals.length ? SIGNAL_CODES[world.signals[0]] : 0);
  try {
    installSignalCleanup(registry, {
      stdin: world.stdin = new EventEmitter(),
      exit: (code) => { world.exit ??= { code, signals: world.signals.length, waited: world.inScheduled }; },
      setExitCode: (code) => world.codes.push(code),
      schedule: (fn) => world.scheduled.push(fn),
    });
    const possible = () => {
      if (world.exit) return [];
      const out = [];
      if (!world.eof) out.push("eof");
      // The same signal twice too: a second Ctrl-C is the usual way to force an exit.
      if (world.signals.length < 2) out.push(...Object.keys(SIGNAL_CODES));
      if (world.scheduled.length) out.push("scheduled-exit");
      if ((world.eof || world.signals.length) && !world.lateTried) out.push("late-spawn");
      for (const c of kids) {
        if (!c.exited) out.push(`${c.name}.exits`);
        const i = c.attempts.findIndex((a) => a.outcome === null);
        if (i !== -1) for (const o of OUTCOMES) if (o !== "true" || c.exited) out.push(`${c.name}.stop#${i}=${o}`);
      }
      return out;
    };
    for (const choice of choices) {
      const shuttingDown = world.eof || world.signals.length > 0;
      const c = kids.find((k) => choice.startsWith(`${k.name}.`));
      if (choice === "eof") { world.eof = true; world.stdin.emit("end"); }
      else if (choice in SIGNAL_CODES) { world.signals.push(choice); process.emit(choice); }
      else if (choice === "scheduled-exit") { world.inScheduled = true; world.scheduled.shift()(); world.inScheduled = false; }
      else if (choice === "late-spawn") {
        world.lateTried = true;
        try { registry.track(() => { world.lateSpawned = true; return { kill: async () => true }; }); } catch {}
      } else if (choice.endsWith(".exits")) { c.exited = true; c.child.emit("exit", 0, null); }
      else {
        const [, i, outcome] = /\.stop#(\d+)=(\w+)$/.exec(choice);
        const attempt = c.attempts[Number(i)];
        attempt.outcome = outcome;
        if (outcome === "true") c.confirmed = true;
        if (outcome === "reject") attempt.settle.reject(new Error("kill failed"));
        else attempt.settle.resolve(outcome === "true");
      }
      if (!shuttingDown && (world.eof || world.signals.length) && world.codes.at(-1) !== expectedSoFar()) {
        world.violations.push(`exit code not set when shutdown began (${world.codes.at(-1)})`);
      }
      if (choice in SIGNAL_CODES && world.signals.length === 2 && !world.exit) world.violations.push("a second signal did not exit at once");
      await new Promise((r) => setImmediate(r));
    }
    return { world, kids, next: possible() };
  } finally {
    process.off("unhandledRejection", onRejection);
    for (const [s, listeners] of Object.entries(before)) {
      for (const l of process.listeners(s)) if (!listeners.includes(l)) process.removeListener(s, l);
    }
  }
}

function check({ world, kids, next }) {
  const out = [...world.violations];
  if (world.rejections.length) out.push("an unhandled rejection");
  if (world.lateSpawned) out.push("a process started after shutdown began, so no stop reaches it (doctor's handshake agent after a signal ended its version probe)");
  const { exit } = world;
  if (!exit) {
    if (next.length === 0 && (world.eof || world.signals.length)) out.push("shutdown never exited once every stop settled");
    return out;
  }
  const bySecondSignal = exit.signals >= 2;
  const code = bySecondSignal ? SIGNAL_CODES[world.signals[1]] : world.signals.length ? SIGNAL_CODES[world.signals[0]] : 0;
  if (exit.code !== code) out.push(`exited ${exit.code}, expected ${code}`);
  if (!bySecondSignal && world.codes.at(-1) !== code) out.push(`exit code left at ${world.codes.at(-1)}, expected ${code}`);
  if (!bySecondSignal && !exit.waited) out.push("exited outside the scheduled exit");
  for (const c of kids) {
    // Each attempt sends its kill as it starts, so a child with one has been killed.
    if (!c.attempts.length) {
      out.push(c.exited
        ? `${c.name} exited by itself and was never stopped, so nothing killed what it left in its process group`
        : `${c.name} was never stopped`);
    }
    if (c.confirmed || bySecondSignal) continue;
    if (c.attempts.some((a) => a.outcome === null)) out.push(`exited while ${c.name}'s stop was running`);
    if (c.attempts.length < 2) out.push(`exited without retrying ${c.name}'s stop`);
  }
  return out;
}

const owner = (event) => CHILDREN.find((name) => event?.startsWith(`${name}.`));
const isExit = (event) => event?.endsWith(".exits");
const shutdownBegan = (events) => events.some((e) => e === "eof" || e in SIGNAL_CODES);
// Pairs taken in one order only, each skip checked against the other order. The agent goes before
// the probe; an exit goes before anything else, and a late spawn right after the first trigger.
function swappedOrderExplored(path, next) {
  const prev = path.at(-1);
  if (prev === undefined) return false;
  if (isExit(next)) return !isExit(prev) || owner(prev) === "probe";
  if (next === "late-spawn") return shutdownBegan(path.slice(0, -1));
  return owner(prev) === "probe" && owner(next) === "agent";
}

function digest({ world, kids, next }) {
  return JSON.stringify({
    exit: world.exit, codes: world.codes, scheduled: world.scheduled.length, rejections: world.rejections.length,
    violations: world.violations, late: [world.lateTried, world.lateSpawned], next: [...next].sort(),
    kids: kids.map((c) => [c.attempts.map((a) => a.outcome), c.confirmed, c.exited]),
  });
}

test("shutdown keeps its promises under every order of signals, stdin EOF, exits and stop outcomes", { timeout: 300000 }, async (t) => {
  const found = new Map();
  let paths = 0;
  const stack = [[]];
  while (stack.length) {
    const path = stack.pop();
    const run = await replay(path);
    for (const v of check(run)) if (!found.has(v)) found.set(v, path.join(", "));
    const next = [];
    for (const c of run.next) {
      if (!swappedOrderExplored(path, c)) { next.push(c); continue; }
      const [here, swapped] = [await replay([...path, c]), await replay([...path.slice(0, -1), c, path.at(-1)])];
      if (digest(here) !== digest(swapped)) found.set(`${path.at(-1)} and ${c} do not commute, so skipping one order hides states`, path.join(", "));
    }
    if (next.length === 0) paths++;
    else for (const c of next) stack.push([...path, c]);
  }
  t.diagnostic(`${paths} orderings`);
  const report = [...found].map(([v, path]) => `${v}\n  after: ${path}`).join("\n");
  assert.equal(found.size, 0, `${found.size} broken over ${paths} orderings:\n${report}`);
});
