#!/usr/bin/env node
// Live candidate acceptance. Creates only a temporary local Git fixture and never accesses
// production services. Invoke through npm only after a candidate tarball has been installed.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2] || "probe";
const serverPath = process.env.CANDIDATE_SERVER;
if (!serverPath) throw new Error("CANDIDATE_SERVER must point at the installed candidate src/server.js");

function payload(result) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

async function connect(stateRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      CURSOR_DELEGATE_STATE_DIR: stateRoot,
    },
  });
  const client = new Client({ name: "cursor-delegate-live-acceptance", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function makeWorkspace(label) {
  const base = process.env.CANDIDATE_EVIDENCE_ROOT
    || join(tmpdir(), "cursor-delegate-live-");
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, `${label}-`));
  await writeFile(join(workspace, "README.md"), `# ${label}\n\nHarmless acceptance fixture.\n`);
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["add", "README.md"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codex Acceptance", "-c", "user.email=codex@example.invalid",
    "commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

async function startJob(client, workspace, spec, clientRequestId, extra = {}) {
  return payload(await client.callTool({
    name: "start",
    arguments: {
      spec,
      workspace,
      clientRequestId,
      ...extra,
    },
  }));
}

async function waitUntil(client, jobId, predicate, deadlineMs) {
  let revision;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const snapshot = payload(await client.callTool({
      name: "wait",
      arguments: { jobId, afterRevision: revision, timeoutMs: 30_000 },
    }));
    revision = snapshot.revision;
    if (predicate(snapshot)) return snapshot;
  }
  throw new Error(`job ${jobId} did not satisfy the expected condition`);
}

if (mode === "probe") {
  const stateRoot = await mkdtemp(join(tmpdir(), "cursor-delegate-probe-"));
  const client = await connect(stateRoot);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const doctor = payload(await client.callTool({
      name: "doctor",
      arguments: { deep: true },
    }));
    console.log(JSON.stringify({ tools, doctor }, null, 2));
  } finally {
    await client.close();
  }
} else if (mode === "short") {
  const workspace = await makeWorkspace("short");
  const stateRoot = await mkdtemp(join(tmpdir(), "cursor-delegate-short-state-"));
  const client = await connect(stateRoot);
  try {
    const started = await startJob(
      client,
      workspace,
      "Answer with exactly SHORT_ASYNC_OK. Do not use tools and do not edit files.",
      `short-${Date.now()}`,
      { mode: "ask" }
    );
    const terminal = await waitUntil(
      client,
      started.jobId,
      (snapshot) => ["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.status),
      180_000
    );
    const result = payload(await client.callTool({
      name: "result",
      arguments: { jobId: started.jobId },
    }));
    console.log(JSON.stringify({ started, terminal, result, workspace, stateRoot }, null, 2));
  } finally {
    await client.close();
  }
} else if (mode === "cancel") {
  const workspace = await makeWorkspace("cancel");
  const stateRoot = await mkdtemp(join(tmpdir(), "cursor-delegate-cancel-state-"));
  const client = await connect(stateRoot);
  try {
    const started = await startJob(
      client,
      workspace,
      "Using PowerShell, run Start-Sleep -Seconds 120 in the current workspace. Do not access any other path. After it exits, answer CANCEL_SHOULD_NOT_FINISH.",
      `cancel-${Date.now()}`
    );
    await waitUntil(client, started.jobId, (snapshot) => Boolean(snapshot.sessionId), 120_000);
    const cancellation = payload(await client.callTool({
      name: "cancel",
      arguments: { jobId: started.jobId, force: true },
    }));
    const terminal = await waitUntil(
      client,
      started.jobId,
      (snapshot) => ["cancelled", "failed", "succeeded", "interrupted"].includes(snapshot.status),
      120_000
    );
    const result = payload(await client.callTool({
      name: "result",
      arguments: { jobId: started.jobId },
    }));
    console.log(JSON.stringify({ started, cancellation, terminal, result, workspace, stateRoot }, null, 2));
  } finally {
    await client.close();
  }
} else if (mode === "long") {
  const workspace = await makeWorkspace("long");
  const stateRoot = await mkdtemp(join(tmpdir(), "cursor-delegate-long-state-"));
  const startedAt = Date.now();
  let client = await connect(stateRoot);
  const started = await startJob(
    client,
    workspace,
    "Using PowerShell, run Start-Sleep -Seconds 321 in the current workspace. Do not access any other path. After it exits, answer exactly LONG_ASYNC_OK.",
    `long-${startedAt}`
  );
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  client = await connect(stateRoot);
  try {
    const terminal = await waitUntil(
      client,
      started.jobId,
      (snapshot) => ["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.status),
      345_000
    );
    const result = payload(await client.callTool({
      name: "result",
      arguments: { jobId: started.jobId },
    }));
    console.log(JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      started,
      terminal,
      result,
      workspace,
      stateRoot,
    }, null, 2));
  } finally {
    await client.close();
  }
} else {
  throw new Error(`unknown acceptance mode: ${mode}`);
}
