import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AcpClient } from "../src/acp-client.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { runDelegate } from "../src/delegate.js";

// Mid-turn idle detection is opt-in, so tests that exercise it pass idleMs explicitly.
const TIMING = { idleMs: 200, handshakeMs: 400, hardCapMs: 1500 };

function stubFactory(stubFile) {
  return ({ onElicit, mode, onCreatePlan }) => new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL(`./fixtures/${stubFile}`, import.meta.url))],
      options: { shell: false },
    },
    onElicit,
    mode,
    onCreatePlan,
  });
}

test("idle timeout rejects promptly without waiting for escalation grace periods", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("silent-stub.js"),
      idleMs: 150,
      hardCapMs: 10000,
    }),
    (err) => {
      assert.equal(err.reason, "idle-timeout");
      return true;
    }
  );
  assert.ok(Date.now() - start < 500, "expected prompt rejection, not blocked by escalation sleeps");
});

test("idle timeout fires on a silent stub", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("silent-stub.js"),
      ...TIMING,
      hardCapMs: 10000,
    }),
    (err) => {
      assert.equal(err.reason, "idle-timeout");
      assert.match(err.message, /idle timeout/i);
      return true;
    }
  );
  assert.ok(Date.now() - start < 2000, "expected idle timeout within 2s");
});

test("idle timeout does not fire while stub streams updates faster than idleMs", async () => {
  const out = await runDelegate({
    spec: "stream",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: stubFactory("streaming-stub.js"),
    ...TIMING,
    hardCapMs: 10000,
  });
  assert.equal(out.stopReason, "end_turn");
  assert.match(out.result, /tick-/);
});

test("hard-cap fires on a stub that streams forever", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "forever",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("infinite-stream-stub.js"),
      idleMs: 800,
      hardCapMs: 400,
    }),
    (err) => {
      assert.equal(err.reason, "hard-cap");
      assert.match(err.message, /hard-cap/i);
      return true;
    }
  );
  assert.ok(Date.now() - start < 2000, "expected hard-cap within 2s");
});

test("handshake exit rejects promptly", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "task",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("exit-handshake-stub.js"),
      ...TIMING,
      hardCapMs: 10000,
    }),
    (err) => {
      assert.equal(err.reason, "agent-exit");
      assert.match(err.message, /agent exited \(code=2\)/);
      assert.match(err.message, /handshake-boom/);
      return true;
    }
  );
  assert.ok(Date.now() - start < 2000, "expected fail-fast handshake exit");
});

test("handshake hang rejects via the handshake deadline, with idle detection off", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "task",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("handshake-hang-stub.js"),
      idleMs: 0,
      handshakeMs: 300,
      hardCapMs: 10000,
    }),
    (err) => {
      assert.equal(err.reason, "handshake-timeout");
      assert.match(err.message, /handshake timeout/i);
      return true;
    }
  );
  assert.ok(Date.now() - start < 2000, "expected handshake deadline during handshake");
});

// The reported bug: cursor-agent emits nothing while a shell command runs, so a healthy
// long command was indistinguishable from a hang and got killed at 90s.
// docs/acp-probes/2026-07-21-client-terminal-capability measured 26.9s of dead wire for a
// 20s command. Post-handshake silence must no longer settle the session by default.
test("post-handshake silence does not trip by default", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("silent-stub.js"),
      handshakeMs: 200,
      hardCapMs: 900,
    }),
    (err) => {
      assert.equal(err.reason, "hard-cap", "silence during the turn must not read as a hang");
      return true;
    }
  );
});

test("timeout errors name the last tool call and frame age", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("silent-stub.js"),
      handshakeMs: 200,
      hardCapMs: 700,
    }),
    (err) => {
      assert.match(err.message, /Last ACP frame \d+s ago/);
      assert.match(err.message, /does not stream shell output over ACP/);
      return true;
    }
  );
});

test("the handshake deadline does not fire once the prompt is in flight", async () => {
  const out = await runDelegate({
    spec: "stream",
    mode: "agent",
    workspace: process.cwd(),
    clientFactory: stubFactory("streaming-stub.js"),
    handshakeMs: 250,
    hardCapMs: 10000,
  });
  assert.equal(out.stopReason, "end_turn");
});

test("opt-in idle guard trips on mid-turn silence when configured", async () => {
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("silent-stub.js"),
      idleMs: 200,
      handshakeMs: 10000,
      hardCapMs: 10000,
    }),
    (err) => {
      assert.equal(err.reason, "idle-timeout");
      return true;
    }
  );
});

test("heartbeat progress reports elapsed time and frame age during a silent turn", async () => {
  const lines = [];
  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("silent-stub.js"),
      handshakeMs: 10000,
      hardCapMs: 700,
      heartbeatMs: 100,
      onProgress: (m) => lines.push(m),
    }),
    (err) => err.reason === "hard-cap"
  );
  const beats = lines.filter((l) => l.startsWith("still working"));
  assert.ok(beats.length >= 2, `expected repeated heartbeats, got ${JSON.stringify(beats)}`);
  assert.match(beats[0], /elapsed, last agent frame \d+s ago/);
});

test("escalation order idle→cancel→kill with child dead afterward", async () => {
  const written = [];
  let childRef;
  let exitPromise;

  const factory = ({ onElicit, mode, onCreatePlan }) => {
    const client = stubFactory("escalation-stub.js")({ onElicit, mode, onCreatePlan });
    const origStart = client.start.bind(client);
    client.start = async () => {
      await origStart();
      childRef = client.child;
      exitPromise = new Promise((resolve) => childRef.once("exit", resolve));
      const origWrite = client.peer.output.write.bind(client.peer.output);
      client.peer.output.write = (chunk) => {
        written.push(chunk.toString());
        return origWrite(chunk);
      };
    };
    return client;
  };

  await assert.rejects(
    () => runDelegate({
      spec: "hang",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: factory,
      ...TIMING,
      handshakeMs: 10000,
      hardCapMs: 10000,
    }),
    (err) => err.reason === "idle-timeout"
  );

  await exitPromise;
  const cancelLine = written.find((w) => w.includes("session/cancel"));
  assert.ok(cancelLine, "expected session/cancel notification");
  assert.ok(childRef, "expected child reference");
  assert.ok(
    childRef.exitCode !== null || childRef.signalCode !== null,
    "expected child to be dead after escalation"
  );
});

test("resumed filesReportedByAgent excludes diff replayed during session/load (Bug B)", async () => {
  function replayTouchedFactory() {
    return ({ onElicit, mode, onCreatePlan }) => {
      const client = stubFactory("fake-acp.js")({ onElicit, mode, onCreatePlan });
      const origLoad = client.loadSession.bind(client);
      client.loadSession = async (sessionId, cwd) => {
        const res = await origLoad(sessionId, cwd);
        client.emit("update", {
          update: {
            sessionUpdate: "tool_call_update",
            content: [{ type: "diff", path: "stale-replay.txt" }],
          },
        });
        return res;
      };
      return client;
    };
  }

  const out = await runDelegate({
    spec: "continue",
    mode: "agent",
    resumeSessionId: "sess-resumed",
    workspace: process.cwd(),
    clientFactory: replayTouchedFactory(),
  });
  assert.equal(out.resumed, true);
  assert.deepEqual(out.filesReportedByAgent, ["hello.txt"]);
  assert.ok(!out.filesReportedByAgent.includes("stale-replay.txt"));
});

test("inline spec equal to an existing filename is sent literally (Bug C)", async () => {
  const inlineSpec = "inline-spec-bug-c-footgun";
  const path = join(process.cwd(), inlineSpec);
  writeFileSync(path, "file contents should not be used\n");
  let promptText;
  try {
    await runDelegate({
      spec: inlineSpec,
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: ({ onElicit, mode, onCreatePlan }) => {
        const client = stubFactory("fake-acp.js")({ onElicit, mode, onCreatePlan });
        const origPrompt = client.prompt.bind(client);
        client.prompt = async (sessionId, blocks) => {
          promptText = blocks.find((b) => b.type === "text")?.text;
          return origPrompt(sessionId, blocks);
        };
        return client;
      },
    });
    assert.equal(promptText, inlineSpec);
  } finally {
    try { unlinkSync(path); } catch {}
  }
});

test("abort() rejects supervised work and sends a courtesy cancel", async () => {
  const sessionId = "sess-abort";
  const cancelCalls = [];

  const client = new EventEmitter();
  client.on = (...args) => EventEmitter.prototype.on.call(client, ...args);
  client.off = (...args) => EventEmitter.prototype.off.call(client, ...args);
  client.cancel = async (sid) => { cancelCalls.push(sid); };

  const supervisor = new SessionSupervisor(client);
  supervisor.setSessionId(sessionId);

  const work = supervisor.supervise(() => new Promise(() => {}));
  supervisor.abort();

  await assert.rejects(work, (err) => {
    assert.equal(err.reason, "aborted");
    assert.match(err.message, /aborted by MCP host/i);
    return true;
  });

  assert.deepEqual(cancelCalls, [sessionId]);
});

test("_trip sends courtesy cancel when sessionId is set but not when null", async () => {
  const cancelCalls = [];

  const makeClient = () => {
    const client = new EventEmitter();
    client.on = (...args) => EventEmitter.prototype.on.call(client, ...args);
    client.off = (...args) => EventEmitter.prototype.off.call(client, ...args);
    client.cancel = async (sid) => { cancelCalls.push(sid); };
    return client;
  };

  // With sessionId set
  const client1 = makeClient();
  const sup1 = new SessionSupervisor(client1, { handshakeMs: 50, hardCapMs: 10000 });
  sup1.setSessionId("sess-1");
  await assert.rejects(
    sup1.supervise(() => new Promise(() => {})),
    (err) => err.reason === "handshake-timeout"
  );
  assert.deepEqual(cancelCalls, ["sess-1"]);

  // Without sessionId
  cancelCalls.length = 0;
  const client2 = makeClient();
  const sup2 = new SessionSupervisor(client2, { handshakeMs: 50, hardCapMs: 10000 });
  await assert.rejects(
    sup2.supervise(() => new Promise(() => {})),
    (err) => err.reason === "handshake-timeout"
  );
  assert.deepEqual(cancelCalls, []);
});
