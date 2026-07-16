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

const TIMING = { idleMs: 200, hardCapMs: 1500, cancelGraceMs: 200, killGraceMs: 100 };

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
      cancelGraceMs: 2000,
      killGraceMs: 2000,
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
      cancelGraceMs: 100,
      killGraceMs: 100,
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

test("handshake hang rejects via idle timeout", async () => {
  const start = Date.now();
  await assert.rejects(
    () => runDelegate({
      spec: "task",
      mode: "agent",
      workspace: process.cwd(),
      clientFactory: stubFactory("handshake-hang-stub.js"),
      ...TIMING,
      hardCapMs: 10000,
    }),
    (err) => {
      assert.equal(err.reason, "idle-timeout");
      return true;
    }
  );
  assert.ok(Date.now() - start < 2000, "expected idle timeout during handshake");
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

test("resumed touchedFiles excludes diff replayed during session/load (Bug B)", async () => {
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
    gitChangedSet: () => null, // isolate the replay-exclusion logic from real git state (diff-only)
  });
  assert.equal(out.resumed, true);
  assert.deepEqual(out.touchedFiles, ["hello.txt"]);
  assert.ok(!out.touchedFiles.includes("stale-replay.txt"));
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
        client.prompt = async (sessionId, text) => {
          promptText = text;
          return origPrompt(sessionId, text);
        };
        return client;
      },
    });
    assert.equal(promptText, inlineSpec);
  } finally {
    try { unlinkSync(path); } catch {}
  }
});

test("abort() rejects supervised work and runs escalation", async () => {
  const sessionId = "sess-abort";
  const cancelCalls = [];
  let killCalled = false;
  const child = new EventEmitter();
  child.pid = process.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    killCalled = true;
    child.exitCode = 1;
    child.signalCode = "SIGTERM";
    child.emit("exit", 1, "SIGTERM");
  };

  const client = new EventEmitter();
  client.on = (...args) => EventEmitter.prototype.on.call(client, ...args);
  client.off = (...args) => EventEmitter.prototype.off.call(client, ...args);
  client.cancel = async (sid) => { cancelCalls.push(sid); };
  client.child = child;

  const supervisor = new SessionSupervisor(client, {
    cancelGraceMs: 50,
    killGraceMs: 50,
  });
  supervisor.setSessionId(sessionId);

  const work = supervisor.supervise(() => new Promise(() => {}));
  supervisor.abort();

  await assert.rejects(work, (err) => {
    assert.equal(err.reason, "aborted");
    assert.match(err.message, /aborted by MCP host/i);
    return true;
  });

  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(cancelCalls, [sessionId]);
  assert.ok(killCalled, "expected child.kill during escalation");
});
