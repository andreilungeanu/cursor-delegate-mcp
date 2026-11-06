#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalDelegateRequest, claimSessionLock, releaseSessionLock } from "./job-locks.js";
import {
  appendJobEvent,
  jobDirectory,
  readJobCancelRequest,
  readJson,
  updateJobState,
  writeJobResultOnce,
} from "./job-store.js";
import { runDelegate as runDelegateDefault } from "./delegate.js";
import { jobIdSchema } from "./job-contract.js";

const DEFAULT_HEARTBEAT_MS = 5_000;

/** @param {unknown} error */
function errorSummary(error) {
  return String(/** @type {any} */ (error)?.message || error || "unknown runner failure").slice(0, 1_000);
}

/** @param {() => string} now */
function isoNow(now) {
  return now();
}

/**
 * Execute one persisted job in this process. The MCP server starts this function through a
 * detached child; tests inject runDelegate and shortened timings.
 *
 * @param {{
 *   root: string,
 *   jobId: string,
 *   runDelegate?: (options: Record<string, any>) => Promise<any>,
 *   heartbeatMs?: number,
 *   cancelPollMs?: number,
 *   forceGraceMs?: number,
 *   now?: () => string,
 * }} options
 */
export async function runDelegationJob(options) {
  const jobId = jobIdSchema.parse(options.jobId);
  const runDelegate = options.runDelegate || runDelegateDefault;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const cancelPollMs = options.cancelPollMs ?? 250;
  const forceGraceMs = options.forceGraceMs ?? 500;
  const now = options.now ?? (() => new Date().toISOString());
  const directory = jobDirectory(options.root, jobId);
  const storedRequest = await readJson(path.join(directory, "request.json"));
  const request = canonicalDelegateRequest(storedRequest);
  const clientRequestId = storedRequest.clientRequestId;
  const startedAt = isoNow(now);

  await updateJobState(options.root, jobId, (state) => ({
    ...state,
    status: "starting",
    phase: "starting-runner",
    startedAt,
    heartbeatAt: startedAt,
    runner: { pid: process.pid, startedAt },
  }), { now });
  await appendJobEvent(options.root, jobId, {
    type: "runner-started",
    at: startedAt,
    pid: process.pid,
  }, { now });

  let client;
  let sessionId = null;
  let sessionLockHeld = false;
  let pendingUpdate = Promise.resolve();
  const files = new Set();
  let lastToolLabel = null;
  let todoProgress = null;
  let heartbeat;
  let cancelPoll;
  let cancelRequested = false;
  let forceScheduled = false;
  const cancellation = new AbortController();

  const queueStateUpdate = (updater) => {
    pendingUpdate = pendingUpdate.then(async () => {
      await updateJobState(options.root, jobId, updater, { now });
    });
    return pendingUpdate;
  };

  const recordProgress = (message) => {
    const at = isoNow(now);
    if (message.startsWith("running: ")) lastToolLabel = message.slice("running: ".length);
    if (message.startsWith("editing ")) files.add(message.slice("editing ".length));
    void queueStateUpdate((state) => ({
      ...state,
      phase: state.status === "running" ? "prompt" : state.phase,
      lastActivityAt: at,
      heartbeatAt: at,
      lastToolLabel,
      filesReportedByEditTools: files.size ? [...files] : state.filesReportedByEditTools,
    })).catch(() => {});
    void appendJobEvent(options.root, jobId, {
      type: "progress",
      at,
      message,
      lastToolLabel,
    }, { now }).catch(() => {});
  };

  const startHeartbeat = () => {
    heartbeat = setInterval(() => {
      const at = isoNow(now);
      void queueStateUpdate((state) => ({
        ...state,
        heartbeatAt: at,
      })).catch(() => {});
    }, heartbeatMs);
    heartbeat.unref?.();
  };

  const applyCancellationRequest = async () => {
    const request = await readJobCancelRequest(options.root, jobId);
    if (!request) return null;
    if (!cancelRequested) {
      cancelRequested = true;
      await queueStateUpdate((state) => ({
        ...state,
        status: "cancelling",
        phase: request.force ? "force-cancel-requested" : "cancel-requested",
        cancelRequested: true,
      }));
      if (client && sessionId) await Promise.resolve(client.cancel?.(sessionId)).catch(() => {});
    }
    if (request.force && !forceScheduled) {
      forceScheduled = true;
      const timer = setTimeout(() => {
        void (async () => {
          if (client && sessionId) await Promise.resolve(client.cancel?.(sessionId)).catch(() => {});
          cancellation.abort();
        })();
      }, forceGraceMs);
      timer.unref?.();
    }
    return request;
  };

  const earlyCancellation = await readJobCancelRequest(options.root, jobId);
  if (earlyCancellation) {
    cancelRequested = true;
    const finishedAt = isoNow(now);
    const outcome = {
      status: "cancelled",
      jobId,
      reason: "cancel-requested",
      message: "cancellation was requested before the runner started the agent",
      sessionId: null,
      clientRequestId: clientRequestId ?? null,
      localTermination: "not-started",
      remoteTermination: "not-applicable",
      finishedAt,
    };
    await writeJobResultOnce(options.root, jobId, outcome);
    await updateJobState(options.root, jobId, (state) => ({
      ...state,
      status: "cancelled",
      phase: "cancelled",
      finishedAt,
      heartbeatAt: null,
      lastActivityAt: finishedAt,
      cancelRequested: true,
      localTermination: "not-started",
      remoteTermination: "not-applicable",
      errorSummary: null,
    }), { now });
    await appendJobEvent(options.root, jobId, {
      type: "job-cancelled",
      at: finishedAt,
      localTermination: "not-started",
      remoteTermination: "not-applicable",
    }, { now });
    return outcome;
  }

  startHeartbeat();
  cancelPoll = setInterval(() => {
    void applyCancellationRequest().catch(() => {});
  }, cancelPollMs);
  cancelPoll.unref?.();
  let delegateResult;
  let failure;
  try {
    delegateResult = await runDelegate({
      ...request,
      signal: cancellation.signal,
      onClientReady: (readyClient) => {
        client = readyClient;
      },
      onSessionReady: (readySessionId) => {
        sessionId = readySessionId;
        void queueStateUpdate((state) => ({
          ...state,
          status: "running",
          phase: "awaiting-session-lock",
          sessionId,
        })).catch(() => {});
      },
      beforePrompt: async ({ sessionId: promptSessionId }) => {
        await claimSessionLock({
          root: options.root,
          sessionId: promptSessionId,
          jobId,
          now,
        });
        sessionLockHeld = true;
        await queueStateUpdate((state) => ({
          ...state,
          status: "running",
          phase: "prompting",
        }));
      },
      onProgress: recordProgress,
      stopClientOnFinish: false,
    });
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
  }

  await pendingUpdate.catch(() => {});
  await applyCancellationRequest().catch(() => {});
  const cleanupAt = isoNow(now);
  await queueStateUpdate((state) => ({
    ...state,
    phase: "stopping-client",
    heartbeatAt: cleanupAt,
    cancelRequested,
  }));

  let localTermination = client ? "unknown" : "not-started";
  if (client) {
    try {
      localTermination = (await client.stop()) === true ? "confirmed" : "failed";
    } catch {
      localTermination = "failed";
    }
  }
  const remoteTermination = localTermination === "not-started" ? "not-applicable" : "unknown";
  const finishedAt = isoNow(now);

  let outcome;
  if (cancelRequested && localTermination === "confirmed") {
    outcome = {
      status: "cancelled",
      jobId,
      reason: "cancel-requested",
      message: failure
        ? errorSummary(failure)
        : "the agent completed while cancellation was in progress",
      sessionId,
      clientRequestId: clientRequestId ?? null,
      todoProgress,
      filesReportedByEditTools: files.size ? [...files] : null,
      localTermination,
      remoteTermination,
      finishedAt,
    };
    if (delegateResult !== undefined) outcome.delegateResult = delegateResult;
  } else if (!failure && localTermination === "confirmed") {
    todoProgress = delegateResult.todoProgress ?? null;
    if (delegateResult.filesReportedByEditTools) {
      for (const file of delegateResult.filesReportedByEditTools) files.add(file);
    }
    outcome = {
      ...delegateResult,
      jobId,
      status: "succeeded",
      lifecycle: {
        status: "succeeded",
        sessionId,
        filesReportedByEditTools: files.size ? [...files] : undefined,
        todoProgress,
        localTermination,
        remoteTermination,
        finishedAt,
      },
    };
  } else {
    const reason = failure
      ? (failure.reason || "runner-error")
      : "cleanup-failed";
    const message = failure
      ? errorSummary(failure)
      : "delegation finished but the local Cursor CLI process did not exit";
    outcome = {
      status: "failed",
      jobId,
      reason,
      message,
      holderJobId: failure?.jobId,
      sessionId,
      clientRequestId: clientRequestId ?? null,
      todoProgress,
      filesReportedByEditTools: files.size ? [...files] : null,
      localTermination,
      remoteTermination,
      finishedAt,
    };
    if (delegateResult !== undefined) outcome.delegateResult = delegateResult;
  }

  await writeJobResultOnce(options.root, jobId, outcome);
  const terminalStatus = outcome.status;
  await updateJobState(options.root, jobId, (state) => ({
    ...state,
    status: terminalStatus,
    phase: terminalStatus,
    sessionId,
    finishedAt,
    heartbeatAt: finishedAt,
    lastActivityAt: finishedAt,
    lastToolLabel,
    todoProgress,
    filesReportedByEditTools: files.size ? [...files] : null,
    cancelRequested,
    localTermination,
    remoteTermination,
    errorSummary: terminalStatus === "failed"
      ? { reason: outcome.reason, message: outcome.message }
      : null,
  }), { now });
  await appendJobEvent(options.root, jobId, {
    type: terminalStatus === "succeeded"
      ? "job-succeeded"
      : terminalStatus === "cancelled"
        ? "job-cancelled"
        : "job-failed",
    at: finishedAt,
    reason: outcome.reason,
    localTermination,
    remoteTermination,
  }, { now });

  if (sessionLockHeld && sessionId) {
    await releaseSessionLock(options.root, sessionId, jobId);
  }
  return outcome;
}

const __filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {}
}

if (isMain) {
  const [root, jobId, ...unexpected] = process.argv.slice(2);
  if (!root || !jobId || unexpected.length) {
    console.error("usage: node src/job-runner.js <state-root> <job-id>");
    process.exitCode = 2;
  } else {
    runDelegationJob({ root, jobId }).catch((error) => {
      console.error(`cursor-delegate job runner failed: ${errorSummary(error)}`);
      process.exitCode = 1;
    });
  }
}
