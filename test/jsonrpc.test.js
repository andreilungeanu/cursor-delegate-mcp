import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { JsonRpcPeer, transcriptFrames } from "../src/jsonrpc.js";

function lines(buf) { return buf.split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

// Recording is opt-in, and the flag is read once in the constructor — so the env only has to be
// set across that call, not across the whole test. Every test below that reads the ring buffer
// asks for it the way someone debugging the bridge would.
function recordingPeer(input, output, handlers = {}) {
  const prev = process.env.CURSOR_DELEGATE_TRANSCRIPT;
  process.env.CURSOR_DELEGATE_TRANSCRIPT = "50";
  try { return new JsonRpcPeer(input, output, handlers); }
  finally {
    if (prev === undefined) delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
    else process.env.CURSOR_DELEGATE_TRANSCRIPT = prev;
  }
}

test("request writes a framed call and resolves on matching response", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => { written += c.toString(); });
  const peer = new JsonRpcPeer(input, output, {});
  const p = peer.request("initialize", { x: 1 });
  const sent = lines(written)[0];
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "initialize");
  assert.deepEqual(sent.params, { x: 1 });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
  assert.deepEqual(await p, { ok: true });
});

// The router tests substitute their own respondError, so the frame the peer actually writes for
// an inbound request it cannot handle had never been checked against the wire.
test("respondError answers an inbound request with a JSON-RPC error frame", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => { written += c.toString(); });
  const peer = new JsonRpcPeer(input, output, {
    onRequest: (id, method) => peer.respondError(id, -32601, `Unhandled method: ${method}`),
  });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "cursor/unknown" }) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines(written)[0], {
    jsonrpc: "2.0",
    id: 9,
    error: { code: -32601, message: "Unhandled method: cursor/unknown" },
  });
});

test("a response echoing the id as a string still resolves its request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => { written += c.toString(); });
  const peer = new JsonRpcPeer(input, output, {});
  const p = peer.request("initialize", {});
  const sent = lines(written)[0];
  assert.equal(typeof sent.id, "number");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: String(sent.id), result: { ok: true } }) + "\n");
  assert.deepEqual(await p, { ok: true });
  peer.close();
});

test("inbound notification and request are dispatched by shape", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const notes = []; const reqs = [];
  const peer = new JsonRpcPeer(input, output, {
    onNotification: (m, p) => notes.push([m, p]),
    onRequest: (id, m, p) => reqs.push([id, m, p]),
  });
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { a: 1 } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "session/request_permission", params: { b: 2 } }) + "\n");
  assert.deepEqual(notes, [["session/update", { a: 1 }]]);
  assert.deepEqual(reqs, [[0, "session/request_permission", { b: 2 }]]);
  peer.close();
});

test("error response rejects the request promise", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => { written += c.toString(); });
  const peer = new JsonRpcPeer(input, output, {});
  const p = peer.request("test_method", { x: 1 });
  const sent = lines(written)[0];
  input.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, error: { code: -32000, message: "test error message" } }) + "\n");
  await assert.rejects(p, (err) => {
    assert.equal(err.message, "test error message");
    return true;
  });
});

test("error response keeps the code and the nested data.message", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => { written += c.toString(); });
  const peer = new JsonRpcPeer(input, output, {});
  const p = peer.request("session/set_config_option", { configId: "fast" });
  const sent = lines(written)[0];
  input.write(JSON.stringify({
    jsonrpc: "2.0", id: sent.id,
    error: { code: -32602, message: "Invalid params", data: { message: "Unknown model config option: fast" } },
  }) + "\n");
  await assert.rejects(p, (err) => {
    assert.equal(err.message, "Invalid params: Unknown model config option: fast");
    assert.equal(err.code, -32602);
    return true;
  });
});

test("malformed JSON line is ignored without crashing", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const notes = [];
  const peer = new JsonRpcPeer(input, output, {
    onNotification: (m, p) => notes.push([m, p]),
  });
  input.write("not json\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "valid_notification", params: { ok: true } }) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(notes, [["valid_notification", { ok: true }]]);
  peer.close();
});

test("unmatched response id is dropped silently", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => { written += c.toString(); });
  const peer = new JsonRpcPeer(input, output, {});
  const p = peer.request("test_method", { x: 1 });
  const sent = lines(written)[0];
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { orphan: true } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
  assert.deepEqual(await p, { ok: true });
});

test("records inbound and outbound frames with direction tags", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = recordingPeer(input, output);
  const p = peer.request("initialize", { x: 1 });
  const log = peer.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].dir, "out");
  assert.match(log[0].line, /"method":"initialize"/);
  const sent = JSON.parse(log[0].line);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
  await p;
  const full = peer.getLog();
  assert.equal(full.length, 2);
  assert.equal(full[1].dir, "in");
  assert.match(full[1].line, /"result"/);
  peer.close();
});

test("ring buffer trims to ACP_LOG_SIZE", () => {
  const prev = process.env.ACP_LOG_SIZE;
  process.env.ACP_LOG_SIZE = "3";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = recordingPeer(input, output);
    for (let i = 0; i < 5; i++) peer.notify("ping", { n: i });
    const log = peer.getLog();
    assert.equal(log.length, 3);
    assert.match(log[0].line, /"n":2/);
    assert.match(log[2].line, /"n":4/);
    peer.close();
  } finally {
    if (prev === undefined) delete process.env.ACP_LOG_SIZE;
    else process.env.ACP_LOG_SIZE = prev;
  }
});

test("recording stays off until CURSOR_DELEGATE_TRANSCRIPT asks for it", () => {
  const prev = process.env.CURSOR_DELEGATE_TRANSCRIPT;
  delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output, {});
    peer.notify("ping", {});
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "pong" }) + "\n");
    assert.equal(peer.getLog().length, 0, "the default must retain nothing nobody reads");
    peer.close();
  } finally {
    if (prev === undefined) delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
    else process.env.CURSOR_DELEGATE_TRANSCRIPT = prev;
  }
});

// ACP_LOG_SIZE keeps bounding retention, so 0 still wins over a requested transcript.
test("ACP_LOG_SIZE=0 disables recording", () => {
  const prev = process.env.ACP_LOG_SIZE;
  process.env.ACP_LOG_SIZE = "0";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = recordingPeer(input, output);
    peer.notify("ping", {});
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "pong" }) + "\n");
    assert.equal(peer.getLog().length, 0);
    assert.equal(peer.formatLog(), "");
    peer.close();
  } finally {
    if (prev === undefined) delete process.env.ACP_LOG_SIZE;
    else process.env.ACP_LOG_SIZE = prev;
  }
});

test("a malformed ACP_LOG_SIZE keeps the default instead of disabling recording", () => {
  const prev = process.env.ACP_LOG_SIZE;
  process.env.ACP_LOG_SIZE = "not-a-number";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = recordingPeer(input, output);
    peer.notify("ping", {});
    assert.equal(peer.getLog().length, 1, "a typo must not silently turn the transcript off");
    peer.close();
  } finally {
    if (prev === undefined) delete process.env.ACP_LOG_SIZE;
    else process.env.ACP_LOG_SIZE = prev;
  }
});

// "true" is the most natural value to set, and Number("true") > 0 is false — the flag used to
// disable exactly what the setter was asking for.
test("a non-numeric CURSOR_DELEGATE_TRANSCRIPT records instead of disabling", () => {
  const prev = process.env.CURSOR_DELEGATE_TRANSCRIPT;
  process.env.CURSOR_DELEGATE_TRANSCRIPT = "true";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output, {});
    peer.notify("ping", {});
    assert.equal(peer.getLog().length, 1, "a boolean-ish value must enable recording, not disable it");
    peer.close();
  } finally {
    if (prev === undefined) delete process.env.CURSOR_DELEGATE_TRANSCRIPT;
    else process.env.CURSOR_DELEGATE_TRANSCRIPT = prev;
  }
});

test("transcriptFrames parses the env forms", () => {
  assert.equal(transcriptFrames(undefined), 0);
  assert.equal(transcriptFrames(""), 0);
  assert.equal(transcriptFrames("  "), 0);
  assert.equal(transcriptFrames("0"), 0);
  assert.equal(transcriptFrames("-3"), 0);
  assert.equal(transcriptFrames("12"), 12);
  assert.equal(transcriptFrames("7.9"), 7);
  assert.equal(transcriptFrames("true"), 50, "an unparseable value reads as on at the default depth");
});

test("per-frame size is capped at FRAME_CAP", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = recordingPeer(input, output);
  const long = "x".repeat(3000);
  input.write(long + "\n");
  const log = peer.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].line.length, 2048);
  peer.close();
});

test("formatLog returns last n entries as readable lines", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = recordingPeer(input, output);
  peer.notify("a", {});
  peer.notify("b", {});
  peer.notify("c", {});
  const formatted = peer.formatLog(2);
  assert.match(formatted, / out .*"method":"b"/);
  assert.match(formatted, / out .*"method":"c"/);
  assert.doesNotMatch(formatted, /"method":"a"/);
  peer.close();
});

test("malformed inbound line is still recorded", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = recordingPeer(input, output);
  input.write("not json\n");
  await new Promise((r) => setImmediate(r));
  const log = peer.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].dir, "in");
  assert.equal(log[0].line, "not json");
  peer.close();
});

test("onActivity fires for a parsed frame and not for anything else on the wire", async () => {
  // The supervisor reads this as "the protocol advanced", and the stall message it feeds calls it
  // "Last ACP frame". A launcher banner, a blank line and a half-written frame are none of those,
  // and counting them let a chatty launcher hold the idle guard open indefinitely.
  const input = new PassThrough();
  const output = new PassThrough();
  let count = 0;
  const peer = new JsonRpcPeer(input, output, { onActivity: () => { count++; } });
  input.write("Cursor CLI 2026.08.11 starting\n");
  input.write("\n");
  input.write("{ not json\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 0, "noise on stdout is not the protocol advancing");

  input.write(JSON.stringify({ jsonrpc: "2.0", method: "ping" }) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 1, "a parsed frame is");
  peer.close();
});

test("rejectAllPending rejects and clears in-flight requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonRpcPeer(input, output, {});
  const p = peer.request("hang", {});
  const err = new Error("agent gone");
  err.reason = "agent-exit";
  peer.rejectAllPending(err);
  await assert.rejects(p, (e) => e === err);
  assert.equal(peer.pending.size, 0);
  peer.close();
});

test("an error on the agent's stdout does not take the server down", async () => {
  // readline re-emits the input stream's error as its own, so the handler on the child's stdout
  // does not cover it. Unhandled, it is an uncaught exception: the whole server, and every
  // concurrent delegation with it. Spawned, because that outcome is a process-level one.
  const fixture = fileURLToPath(new URL("./fixtures/peer-input-error.js", import.meta.url));
  const { code, stderr } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  assert.equal(code, 0, `peer died on an input error: ${stderr.trim() || "<no stderr>"}`);
});
