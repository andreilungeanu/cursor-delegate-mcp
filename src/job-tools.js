import { spawn as spawnDefault } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isTerminalJobStatus,
  jobIdSchema,
  publicJobSnapshot,
  startInputSchema,
} from "./job-contract.js";
import {
  canonicalDelegateRequest,
  claimClientRequest,
  claimSessionLock,
  releaseSessionLock,
} from "./job-locks.js";
import { resolveJobRoot } from "./job-paths.js";
import {
  appendJobEvent,
  claimJobSpawn,
  createJob,
  jobDirectory,
  readJobResult,
  readJobState,
  updateJobState,
  writeJobCancelRequest,
  writeJobResultOnce,
} from "./job-store.js";

const RUNNER_PATH = fileURLToPath(new URL("./job-runner.js", import.meta.url));
const HEARTBEAT_STALE_MS = 30_000;

/** @param {unknown} error */
function reasonOf(error) {
  return /** @type {any} */ (error)?.reason || "start-failed";
}

/**
 * @param {string} root
 * @param {string} jobId
 * @param {{ reason: string, message: string, holderJobId?: string }} failure
 * @param {() => string} now
 */
async function failQueuedJob(root, jobId, failure, now) {
  const finishedAt = now();
  const result = {
    status: "failed",
    jobId,
    reason: failure.reason,
    message: failure.message,
    holderJobId: failure.holderJobId,
    sessionId: null,
    localTermination: "not-started",
    remoteTermination: "not-applicable",
    finishedAt,
  };
  await writeJobResultOnce(root, jobId, result);
  await updateJobState(root, jobId, (state) => ({
    ...state,
    status: "failed",
    phase: "failed",
    finishedAt,
    heartbeatAt: null,
    localTermination: "not-started",
    remoteTermination: "not-applicable",
    errorSummary: { reason: failure.reason, message: failure.message },
  }), { now });
  await appendJobEvent(root, jobId, {
    type: "job-failed",
    at: finishedAt,
    reason: failure.reason,
  }, { now });
  return {
    ok: false,
    jobId,
    reason: failure.reason,
    message: failure.message,
    holderJobId: failure.holderJobId,
  };
}

/**
 * @param {{
 *   root?: string,
 *   args: Record<string, any>,
 *   spawn?: typeof spawnDefault,
 *   now?: () => string,
 * }} options
 */
export async function startPersistentJob(options) {
  const root = options.root || resolveJobRoot();
  const now = options.now ?? (() => new Date().toISOString());
  const args = startInputSchema.parse(options.args);
  const request = canonicalDelegateRequest(args);
  const clientRequestId = args.clientRequestId;
  let sessionLockAcquired = false;

  let created;
  if (clientRequestId) {
    created = await claimClientRequest({
      root,
      clientRequestId,
      request,
      now,
    });
  } else {
    created = {
      created: true,
      job: await createJob({ root, request, now }),
    };
  }
  const initialJob = created.job;
  if (isTerminalJobStatus(initialJob.status)) {
    return {
      ok: initialJob.status === "succeeded",
      job: publicJobSnapshot(initialJob),
      ...(initialJob.errorSummary || {}),
    };
  }

  if (request.resumeSessionId) {
    try {
      await claimSessionLock({
        root,
        sessionId: request.resumeSessionId,
        jobId: initialJob.jobId,
        now,
      });
      sessionLockAcquired = true;
      await updateJobState(root, initialJob.jobId, (state) => ({
        ...state,
        sessionId: request.resumeSessionId,
        phase: "session-locked",
      }), { now });
    } catch (error) {
      return failQueuedJob(root, initialJob.jobId, {
        reason: reasonOf(error),
        message: String(error?.message || error),
        holderJobId: error?.jobId,
      }, now);
    }
  }

  const spawnClaim = await claimJobSpawn(root, initialJob.jobId, { now });
  if (!spawnClaim.claimed) {
    return { ok: true, job: publicJobSnapshot(spawnClaim.state) };
  }

  const runnerLog = path.join(jobDirectory(root, initialJob.jobId), "runner.stderr.log");
  let logHandle;
  try {
    logHandle = await open(runnerLog, "a", 0o600);
    const spawnRunner = options.spawn || spawnDefault;
    const child = spawnRunner(
      process.execPath,
      [RUNNER_PATH, root, initialJob.jobId],
      {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logHandle.fd, logHandle.fd],
      }
    );
    if (!child?.pid) {
      throw Object.assign(new Error("runner spawn returned no pid"), { reason: "spawn-failed" });
    }
    child.once?.("error", (error) => {
      void failQueuedJob(root, initialJob.jobId, {
        reason: "spawn-failed",
        message: String(error?.message || error),
      }, now).catch(() => {});
    });
    child.unref?.();
    const spawnedAt = now();
    await updateJobState(root, initialJob.jobId, (state) => ({
      ...state,
      status: state.status === "queued" ? "starting" : state.status,
      phase: state.status === "queued" ? "runner-spawned" : state.phase,
      startedAt: state.startedAt || spawnedAt,
      heartbeatAt: state.heartbeatAt || spawnedAt,
      runnerPid: child.pid,
      runnerSpawnedAt: spawnedAt,
    }), { now });
    await appendJobEvent(root, initialJob.jobId, {
      type: "runner-spawned",
      at: spawnedAt,
      pid: child.pid,
    }, { now });
    return { ok: true, job: publicJobSnapshot(initialJob) };
  } catch (error) {
    if (sessionLockAcquired && request.resumeSessionId) {
      await releaseSessionLock(root, request.resumeSessionId, initialJob.jobId);
    }
    return failQueuedJob(root, initialJob.jobId, {
      reason: reasonOf(error) === "start-failed" ? "spawn-failed" : reasonOf(error),
      message: String(error?.message || error),
    }, now);
  } finally {
    await logHandle?.close().catch(() => {});
  }
}

/**
 * @param {{
 *   root: string,
 *   jobId: string,
 *   now?: () => string,
 *   nowMs?: number,
 *   isPidAlive?: (pid: number) => boolean,
 * }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function getJobStatus(options) {
  const state = await readJobState(options.root, options.jobId);
  const nowMs = options.nowMs ?? Date.now();
  const lastEvidence = Date.parse(state.heartbeatAt || state.updatedAt || state.createdAt);
  let health = "ok";
  if (isTerminalJobStatus(state.status)) health = "terminal";
  else if (!Number.isFinite(lastEvidence) || nowMs - lastEvidence > HEARTBEAT_STALE_MS) {
    health = "stale";
  }
  return { ...publicJobSnapshot(state), health };
}

/**
 * Poll only the persisted revision. A timeout is a normal observation and never writes state,
 * sends a prompt, or changes a session.
 *
 * @param {{
 *   root: string,
 *   jobId: string,
 *   afterRevision?: number,
 *   timeoutMs: number,
 *   pollMs?: number,
 *   now?: () => string,
 *   nowMs?: () => number,
 *   isPidAlive?: (pid: number) => boolean,
 * }} options
 */
export async function waitForJob(options) {
  const nowMs = options.nowMs ?? Date.now;
  const pollMs = options.pollMs ?? 50;
  const deadline = nowMs() + options.timeoutMs;
  while (true) {
    const job = await getJobStatus({
      root: options.root,
      jobId: options.jobId,
      now: options.now,
      nowMs: nowMs(),
      isPidAlive: options.isPidAlive,
    });
    const changed = options.afterRevision === undefined
      || job.revision > options.afterRevision
      || isTerminalJobStatus(job.status);
    if (changed) return { job, changed: true, timedOut: false };
    const remaining = deadline - nowMs();
    if (remaining <= 0) return { job, changed: false, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

/**
 * @param {{ root: string, jobId: string, now?: string, nowMs?: number }} options
 */
export async function getJobResult(options) {
  const job = await getJobStatus({
    root: options.root,
    jobId: options.jobId,
    nowMs: options.nowMs,
  });
  if (!isTerminalJobStatus(job.status)) {
    return {
      ready: false,
      status: "not-ready",
      job,
    };
  }
  const value = await readJobResult(options.root, options.jobId);
  return {
    ready: true,
    status: value.status || job.status,
    value,
  };
}

/**
 * Persist a cancellation request for a durable job. The runner owns the ACP cancel and process
 * stop; this short server call is safe to repeat and returns the current lifecycle snapshot.
 *
 * @param {{ root: string, jobId: string, force?: boolean, now?: () => string }} options
 */
export async function cancelPersistentJob(options) {
  const jobId = jobIdSchema.parse(options.jobId);
  const cancellation = await writeJobCancelRequest(options.root, jobId, {
    force: options.force,
    now: options.now,
  });
  const state = cancellation.state;
  return {
    jobId,
    sessionId: state.sessionId ?? null,
    status: state.status,
    cancelRequested: Boolean(state.cancelRequested),
    localTermination: state.localTermination ?? "unknown",
    remoteTermination: state.remoteTermination ?? "unknown",
  };
}
