import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { isChildAlive } from "../src/proc.js";

function fakeSpawn() {
  // fileURLToPath (not .pathname) is required on Windows: pathname yields a
  // leading-slash form ("/D:/...") that node.exe mis-resolves as a relative
  // path, double-prefixing the drive letter when spawned.
  return { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-acp.js", import.meta.url))], options: { shell: false } };
}

test("client initializes, opens a session, prompts and emits updates", async () => {
  const updates = [];
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  client.on("update", (u) => updates.push(u));
  await client.start();
  const caps = await client.initialize();
  assert.equal(caps.protocolVersion, 1);
  assert.equal(caps._meta.parameterizedModelPicker, true);
  const s = await client.newSession(process.cwd());
  assert.equal(s.sessionId, "sess-1");
  await client.setModel(s.sessionId, "composer-2.5");
  await client.setFast(s.sessionId, false);
  await client.setMode(s.sessionId, "agent");
  const res = await client.prompt(s.sessionId, "do it");
  assert.equal(res.stopReason, "end_turn");
  assert.equal(updates.at(-1).update.sessionUpdate, "agent_message_chunk");
  // boolean fast is stringified at the ACP boundary
  const fastFrame = client.peer.getLog().find((e) => e.dir === "out" && e.line.includes("set_config_option"));
  assert.equal(JSON.parse(fastFrame.line).params.value, "false");
  client.stop();
});

test("captures stderr and surfaces it on exit", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: ["-e", "process.stderr.write('stderr-line\\n'); process.exit(3);"],
      options: { shell: false },
    },
  });
  const exit = new Promise((resolve) => client.once("exit", resolve));
  await client.start();
  const info = await exit;
  assert.equal(info.code, 3);
  assert.match(info.stderr, /stderr-line/);
  client.stop();
});

test("stop() terminates a live agent child (regression: Windows orphaned agent)", async () => {
  const client = new AcpClient({
    spawnSpec: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/silent-stub.js", import.meta.url))],
      options: { shell: false },
    },
  });
  await client.start();
  assert.ok(isChildAlive(client.child), "child must be alive before stop()");
  const exited = new Promise((resolve) => client.child.once("exit", resolve));
  client.stop();
  await exited;
  assert.ok(!isChildAlive(client.child), "child must be dead after stop()");
});

test("cancel sends session/cancel as a notification without id", async () => {
  const written = [];
  const client = new AcpClient({ spawnSpec: fakeSpawn() });
  await client.start();
  const origWrite = client.peer.output.write.bind(client.peer.output);
  client.peer.output.write = (chunk) => {
    written.push(chunk.toString());
    return origWrite(chunk);
  };
  await client.cancel("sess-1");
  const msg = JSON.parse(written.at(-1).trim());
  assert.equal(msg.method, "session/cancel");
  assert.deepEqual(msg.params, { sessionId: "sess-1" });
  assert.equal(msg.id, undefined);
  client.stop();
});
