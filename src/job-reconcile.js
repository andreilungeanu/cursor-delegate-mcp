import process from "node:process";
import path from "node:path";
import { appendJobEvent, jobDirectory, readJson, withJobLock, writeJobResultWithoutLock, writeJsonAtomic } from "./job-store.js";

const HEARTBEAT_STALE_MS = 30_000;

/** @param {number} pid */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Atomically reconcile one stale job. A live PID alone is not enough to prove progress, so it
 * only yields the derived `stale` health in status. A missing PID or an observed dead PID is
 * positive evidence for `interrupted`; no automatic retry or session recovery follows.
 *
 * @param {{
 *   root: string,
 *   jobId: string,
 *   now?: () => string,
 *   nowMs?: number,
 *   staleMs?: number,
 *   isPidAlive?: (pid: number) => boolean,
 * }} options
 */
export async function reconcileJob(options) {
  const now = options.now ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.staleMs ?? HEARTBEAT_STALE_MS;
  const isPidAlive = options.isPidAlive || processIsAlive;
  const directory = jobDirectory(options.root, options.jobId);

  const reconciled = await withJobLock(directory, async () => {
    const current = await readJson(path.join(directory, "state.json"));
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(current.status)) {
      return { changed: false, state: current, event: null };
    }
    const lastEvidence = Date.parse(current.heartbeatAt || current.updatedAt || current.createdAt);
    if (!Number.isFinite(lastEvidence) || nowMs - lastEvidence <= staleMs) {
      return { changed: false, state: current, event: null };
    }
    if (current.runnerPid && isPidAlive(current.runnerPid)) {
      return { changed: false, state: current, event: null };
    }

    const runnerWasAttempted = Boolean(current.spawnAttemptedAt || current.runnerPid);
    const reason = current.runnerPid ? "runner-exited" : "runner-not-observed";
    const localTermination = runnerWasAttempted ? "unknown" : "not-started";
    const remoteTermination = runnerWasAttempted ? "unknown" : "not-applicable";
    const finishedAt = now();
    const result = {
      status: "interrupted",
      jobId: options.jobId,
      reason,
      message: current.runnerPid
        ? `runner process ${current.runnerPid} exited without a terminal result`
        : "the runner launch was never observed; the job was not retried automatically",
      sessionId: current.sessionId ?? null,
      todoProgress: current.todoProgress ?? null,
      filesReportedByEditTools: current.filesReportedByEditTools ?? null,
      localTermination,
      remoteTermination,
      finishedAt,
    };
    try {
      await writeJobResultWithoutLock(options.root, options.jobId, result);
    } catch (error) {
      if (error?.reason !== "result-exists") throw error;
    }

    const next = {
      ...current,
      status: "interrupted",
      phase: "interrupted",
      revision: Number(current.revision || 0) + 1,
      updatedAt: finishedAt,
      finishedAt,
      localTermination,
      remoteTermination,
      errorSummary: { reason, message: result.message },
    };
    await writeJsonAtomic(path.join(directory, "state.json"), next);
    return { changed: true, state: next, event: { type: "job-interrupted", at: finishedAt, reason } };
  }, { now });

  if (reconciled.event) {
    await appendJobEvent(
      options.root,
      options.jobId,
      reconciled.event,
      { now }
    );
  }
  return reconciled;
}
