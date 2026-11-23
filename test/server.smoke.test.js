import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("../src/server.js", import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const GRANDCHILD_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-with-grandchild.js", import.meta.url));

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
};

// The bin is a stdio server, so an unrecognised flag starts the transport and waits on stdin.
// The version has to come back without a host attached, and it has to be the version of this
// code rather than whatever a manifest pinned.
test("the binary answers --version and exits without starting the transport", async () => {
  // -v too: it is what a hand check reaches for, and falling through to the transport there
  // reads exactly like the wedged install the flag exists to rule out.
  for (const flag of ["--version", "-v"]) {
    const { stdout } = await run(process.execPath, [ENTRY, flag], { timeout: 10000 });
    assert.equal(stdout.trim(), PKG.version, `${flag} must print the version`);
  }
});

// A one-shot host closes stdin as soon as the result arrives, and the server exits on that EOF.
test("a host that closes right after a delegate result leaves no agent process behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdm-oneshot-"));
  const pidFile = join(dir, "pids");
  const client = new Client({ name: "oneshot-host", version: "1" });
  let pids = [];
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, ACP_AGENT_COMMAND: process.execPath, ACP_AGENT_ARGS: `"${GRANDCHILD_AGENT}"`, PID_FILE: pidFile },
      stderr: "ignore",
    }));
    const res = await client.callTool({ name: "delegate", arguments: { workspace: dir, spec: "x" } });
    await client.close();
    assert.equal(res.isError, undefined, res.content[0].text);
    pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    // Room for a kill still in flight to land, so only one that never comes fails the test.
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(pids.filter(isAlive), [], "the agent and its descendants must be gone");
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});
