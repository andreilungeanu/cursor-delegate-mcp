import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { JsonRpcPeer } from "../src/jsonrpc.js";

function lines(buf) { return buf.split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

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
  const peer = new JsonRpcPeer(input, output, {});
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
    const peer = new JsonRpcPeer(input, output, {});
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

test("ACP_LOG_SIZE=0 disables recording", () => {
  const prev = process.env.ACP_LOG_SIZE;
  process.env.ACP_LOG_SIZE = "0";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output, {});
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

test("per-frame size is capped at FRAME_CAP", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonRpcPeer(input, output, {});
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
  const peer = new JsonRpcPeer(input, output, {});
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
  const peer = new JsonRpcPeer(input, output, {});
  input.write("not json\n");
  await new Promise((r) => setImmediate(r));
  const log = peer.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].dir, "in");
  assert.equal(log[0].line, "not json");
  peer.close();
});

test("onActivity fires for every inbound line including malformed", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let count = 0;
  const peer = new JsonRpcPeer(input, output, { onActivity: () => { count++; } });
  input.write("not json\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "ping" }) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 2);
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
