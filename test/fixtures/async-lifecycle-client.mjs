import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../../src/server.js", import.meta.url));
const ACP_FIXTURE = fileURLToPath(new URL("./async-acp.js", import.meta.url));
const ACP_NODE = process.platform === "win32"
  ? "C:\\PROGRA~1\\nodejs\\node.exe"
  : process.execPath;

export function payload(result) {
  if (result.isError) throw new Error(`tool error: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}

export async function connectLifecycleServer(stateRoot, logPath, {
  durationMs = 1200,
  sessionId = `async-${Date.now()}`,
} = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      CURSOR_DELEGATE_STATE_DIR: stateRoot,
      ACP_AGENT_COMMAND: ACP_NODE,
      ACP_AGENT_ARGS: `"${ACP_FIXTURE}"`,
      ASYNC_ACP_DURATION_MS: String(durationMs),
      ASYNC_ACP_SESSION_ID: sessionId,
      ASYNC_ACP_LOG: logPath,
    },
  });
  const client = new Client({ name: "durable-lifecycle-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

export async function waitForTerminal(client, jobId, {
  deadlineMs = 15_000,
  timeoutMs = 1_000,
} = {}) {
  let revision;
  const revisions = [];
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const waited = payload(await client.callTool({
      name: "wait",
      arguments: {
        jobId,
        afterRevision: revision,
        timeoutMs,
      },
    }));
    revisions.push(waited.revision);
    revision = waited.revision;
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(waited.status)) {
      return { job: waited, revisions };
    }
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}
