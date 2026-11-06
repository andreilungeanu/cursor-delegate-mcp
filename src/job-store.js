import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { jobIdSchema } from "./job-contract.js";
import { jobDirectory } from "./job-paths.js";

export { jobDirectory };

export const EVENT_LOG_MAX_BYTES = 1_000_000;
export const RUNNER_STDERR_MAX_BYTES = 256_000;
export const LOCK_TIMEOUT_MS = 5_000;
export const LOCK_STALE_MS = 30_000;

/**
 * @param {string} reason
 * @param {string} message
 * @param {string | undefined} [filePath]
 */
function makeJobStoreError(reason, message, filePath) {
  const error = /** @type {Error & { reason: string, path?: string }} */ (new Error(message));
  error.reason = reason;
  if (filePath) error.path = filePath;
  return error;
}

/** @param {() => string} [now] */
function timestamp(now = () => new Date().toISOString()) {
  return now();
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ mode?: number }} [options]
 */
export async function writeJsonAtomic(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const mode = options.mode ?? 0o600;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<any>}
 */
export async function readJson(filePath) {
  let body;
  try {
    body = await readFile(filePath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      throw makeJobStoreError("job-not-found", `job state not found: ${filePath}`, filePath);
    }
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw makeJobStoreError("state-corrupt", `corrupt JSON state: ${filePath}`, filePath);
  }
}

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
 * Serialize read-modify-write operations across processes. The lock is an exclusively created
 * file; an old lock is recovered only when its owner is provably gone. PID reuse therefore
 * produces contention until the caller's bounded timeout rather than deleting a live lock.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} operation
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => string }} [options]
 * @returns {Promise<T>}
 */
export async function withJobLock(directory, operation, options = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, "state.lock");
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const now = options.now ?? (() => new Date().toISOString());
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({
        pid: process.pid,
        hostname: process.env.COMPUTERNAME || null,
        acquiredAt: now(),
      }));
      await lock.sync();
      await lock.close();
      acquired = true;
      break;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw error;
    }

    let owner;
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {}
    const ownerAge = Date.now() - Date.parse(owner?.acquiredAt || "");
    if (Number.isFinite(ownerAge) && ownerAge > staleMs && !processIsAlive(owner?.pid)) {
      await unlink(lockPath).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) {
      throw makeJobStoreError(
        "job-lock-timeout",
        `timed out waiting for job lock: ${lockPath}`,
        lockPath
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  try {
    return await operation();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * @param {{
 *   root: string,
 *   jobId?: string,
 *   request: Record<string, unknown>,
 *   now?: () => string,
 * }} options
 */
export async function createJob(options) {
  const jobId = jobIdSchema.parse(options.jobId || randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = timestamp(now);
  const directory = jobDirectory(options.root, jobId);
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") {
      throw makeJobStoreError("job-exists", `job already exists: ${jobId}`);
    }
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } else {
      throw error;
    }
  }

  const state = {
    jobId,
    status: "queued",
    revision: 1,
    clientRequestId: options.request.clientRequestId ?? null,
    sessionId: null,
    phase: "persisted",
    createdAt,
    startedAt: null,
    updatedAt: createdAt,
    finishedAt: null,
    heartbeatAt: null,
    lastActivityAt: createdAt,
    lastToolLabel: null,
    todoProgress: null,
    filesReportedByEditTools: null,
    cancelRequested: false,
    localTermination: "not-started",
    remoteTermination: "unknown",
    errorSummary: null,
  };
  await writeJsonAtomic(path.join(directory, "request.json"), options.request);
  await writeJsonAtomic(path.join(directory, "state.json"), state);
  return state;
}

/**
 * @param {string} root
 * @param {string} jobId
 * @param {(state: Record<string, any>) => Record<string, any>} updater
 * @param {{ now?: () => string }} [options]
 */
export async function updateJobState(root, jobId, updater, options = {}) {
  const directory = jobDirectory(root, jobId);
  return withJobLock(directory, async () => {
    const current = await readJson(path.join(directory, "state.json"));
    const patch = await updater(structuredClone(current));
    if (!patch || typeof patch !== "object") {
      throw makeJobStoreError("invalid-state-update", "state updater must return an object");
    }
    const next = {
      ...current,
      ...patch,
      jobId,
      revision: Number(current.revision || 0) + 1,
      updatedAt: timestamp(options.now),
    };
    await writeJsonAtomic(path.join(directory, "state.json"), next);
    return next;
  }, options);
}

/** @param {string} root @param {string} jobId */
export async function readJobState(root, jobId) {
  return readJson(path.join(jobDirectory(root, jobId), "state.json"));
}

/**
 * Read the immutable terminal result without converting missing or corrupt evidence into a
 * successful outcome.
 *
 * @param {string} root
 * @param {string} jobId
 */
export async function readJobResult(root, jobId) {
  const resultPath = path.join(jobDirectory(root, jobId), "result.json");
  let body;
  try {
    body = await readFile(resultPath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      throw makeJobStoreError("result-not-found", `job result not found: ${resultPath}`, resultPath);
    }
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw makeJobStoreError("result-corrupt", `corrupt JSON result: ${resultPath}`, resultPath);
  }
}

/**
 * Append a complete event line. When the bounded log is full, keep the newest whole lines and
 * one explicit truncation marker. Atomic replacement prevents a partial trailing line.
 *
 * @param {string} root
 * @param {string} jobId
 * @param {Record<string, unknown>} event
 * @param {{ maxBytes?: number, now?: () => string }} [options]
 */
export async function appendJobEvent(root, jobId, event, options = {}) {
  const directory = jobDirectory(root, jobId);
  const logPath = path.join(directory, "events.ndjson");
  const maxBytes = options.maxBytes ?? EVENT_LOG_MAX_BYTES;
  return withJobLock(directory, async () => {
    let existing = [];
    try {
      existing = (await readFile(logPath, "utf8"))
        .split("\n")
        .filter(Boolean);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    }
    const next = JSON.stringify(event);
    const currentBytes = existing.length
      ? Buffer.byteLength(existing.join("\n")) + 1
      : 0;
    if (currentBytes + Buffer.byteLength(next) + 1 <= maxBytes) {
      existing.push(next);
    } else {
      const marker = JSON.stringify({
        type: "log-truncated",
        at: timestamp(options.now),
        maxBytes,
      });
      const kept = [];
      let payload = `${marker}\n`;
      for (const line of [...existing, next].reverse()) {
        const candidate = `${line}\n${payload}`;
        if (Buffer.byteLength(candidate) > maxBytes) break;
        kept.unshift(line);
        payload = candidate;
      }
      existing = [marker, ...kept];
    }
    await writeTextAtomic(logPath, `${existing.join("\n")}\n`);
  }, options);
}

/**
 * @param {string} filePath
 * @param {string} body
 */
async function writeTextAtomic(filePath, body) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * @param {string} directory
 * @param {string} jobId
 * @param {Record<string, unknown>} result
 */
async function writeResultFile(directory, jobId, result) {
  const resultPath = path.join(directory, "result.json");
  let descriptor;
  try {
    descriptor = openSync(resultPath, "wx", 0o600);
    const body = `${JSON.stringify(result, null, 2)}\n`;
    writeSync(descriptor, body, null, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor != null) {
      try { closeSync(descriptor); } catch {}
    }
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") {
      throw makeJobStoreError("result-exists", `job result already exists: ${jobId}`, resultPath);
    }
    throw error;
  }
  return result;
}

/**
 * Write a result while the caller already owns the job lock.
 *
 * @param {string} root
 * @param {string} jobId
 * @param {Record<string, unknown>} result
 */
export async function writeJobResultWithoutLock(root, jobId, result) {
  return writeResultFile(jobDirectory(root, jobId), jobId, result);
}

/**
 * @param {string} root
 * @param {string} jobId
 * @param {Record<string, unknown>} result
 */
export async function writeJobResultOnce(root, jobId, result) {
  const directory = jobDirectory(root, jobId);
  return withJobLock(directory, () => writeResultFile(directory, jobId, result));
}

/**
 * Reserve the single runner launch attempt before spawning. A retry after an uncertain start
 * response observes this marker and does not launch a second runner. If the process died
 * between reservation and spawn, reconcile can mark the job interrupted without guessing.
 *
 * @param {string} root
 * @param {string} jobId
 * @param {{ now?: () => string }} [options]
 */
export async function claimJobSpawn(root, jobId, options = {}) {
  const directory = jobDirectory(root, jobId);
  return withJobLock(directory, async () => {
    const current = await readJson(path.join(directory, "state.json"));
    if (
      current.runnerPid
      || current.spawnAttemptedAt
      || ["succeeded", "failed", "cancelled", "interrupted"].includes(current.status)
    ) {
      return { claimed: false, state: current };
    }
    const at = timestamp(options.now);
    const next = {
      ...current,
      spawnToken: randomUUID(),
      spawnAttemptedAt: at,
      revision: Number(current.revision || 0) + 1,
      updatedAt: at,
    };
    await writeJsonAtomic(path.join(directory, "state.json"), next);
    return { claimed: true, state: next };
  }, options);
}
