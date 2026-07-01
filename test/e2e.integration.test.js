import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { runDelegate } from "../src/delegate.js";

const RUN = process.env.ACP_E2E === "1";

test("e2e: delegate creates a file in a temp workspace", { skip: !RUN }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "acp-e2e-"));
  const out = await runDelegate({
    spec: "Create a file named hello.txt containing exactly the word: test",
    mode: "agent",
    workspace: ws,
  });
  assert.equal(out.stopReason, "end_turn");
  assert.ok(existsSync(join(ws, "hello.txt")), "hello.txt should exist");
  assert.ok(
    out.touchedFiles.some((p) => basename(p) === "hello.txt"),
    `touchedFiles should include hello.txt, got: ${JSON.stringify(out.touchedFiles)}`
  );
});
