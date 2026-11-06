import { spawn as spawnDefault } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isTerminalJobStatus,
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
  updateJobState,
  writeJobResultOnce,
} from "./job-store.js";

const RUNNER_PATH = fileURLToPath(new URL("./job-runner.js", import.meta.url));

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
