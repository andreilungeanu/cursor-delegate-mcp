import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { delegateInputSchema, isTerminalJobStatus, jobIdSchema } from "./job-contract.js";
import { createJob, readJobState } from "./job-store.js";

const CLAIM_TIMEOUT_MS = 5_000;
const SESSION_STALE_MS = 30_000;

/** @param {unknown} value */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableValue(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return sorted;
  }
  return value;
}

/** @param {Record<string, unknown>} request */
export function canonicalDelegateRequest(request) {
  const withoutCallerKey = { ...request };
  delete withoutCallerKey.clientRequestId;
  return delegateInputSchema.parse(withoutCallerKey);
}

/** @param {unknown} value */
function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

/** @param {unknown} value */
function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** @param {number} pid */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * @param {string} reason
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function lockError(reason, message, extra = {}) {
  return Object.assign(new Error(message), { reason, ...extra });
}

/**
 * @param {string} filePath
 * @param {Record<string, unknown>} value
 */
async function createJsonExclusive(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** @param {string} filePath */
async function readJsonFile(filePath) {
  let body;
  try {
    body = await readFile(filePath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      throw lockError("lock-not-found", `lock file does not exist: ${filePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw lockError("lock-corrupt", `corrupt lock file: ${filePath}`);
  }
}

/**
 * Claim a stable caller key before creating its job. The index stores only hashes and the
 * job id, never the brief or environment. An exclusive file creation is the winner.
 *
 * @param {{
 *   root: string,
 *   clientRequestId: string,
 *   request: Record<string, unknown>,
 *   now?: () => string,
 * }} options
 */
export async function claimClientRequest(options) {
  if (typeof options.clientRequestId !== "string" || !options.clientRequestId.trim()) {
    throw lockError("invalid-client-request-id", "clientRequestId must be a non-empty string");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const request = canonicalDelegateRequest(options.request);
  const requestHash = sha256(request);
  const keyHash = createHash("sha256").update(options.clientRequestId).digest("hex");
  const directory = path.join(options.root, "indexes", "client-requests");
  const indexPath = path.join(directory, `${keyHash}.json`);
  const deadline = Date.now() + CLAIM_TIMEOUT_MS;

  while (true) {
    const claimToken = randomUUID();
    const jobId = randomUUID();
    const record = {
      requestHash,
      jobId,
      claimToken,
      ownerPid: process.pid,
      createdAt: now(),
    };
    try {
      await createJsonExclusive(indexPath, record);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      const existing = await readJsonFile(indexPath);
      if (existing.requestHash !== requestHash) {
        throw lockError(
          "idempotency-conflict",
          "clientRequestId was already used for a different request"
        );
      }
      jobIdSchema.parse(existing.jobId);
      try {
        const job = await readJobState(options.root, existing.jobId);
        return { created: false, job, indexPath };
      } catch (readError) {
        if (readError?.reason !== "job-not-found") throw readError;
      }
      if (!processIsAlive(existing.ownerPid)) {
        await unlink(indexPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw lockError(
          "idempotency-index-timeout",
          `timed out waiting for clientRequestId claim: ${indexPath}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }

    try {
      const job = await createJob({
        root: options.root,
        jobId,
        request: { ...request, clientRequestId: options.clientRequestId },
        now,
      });
      return { created: true, job, indexPath };
    } catch (error) {
      try {
        const current = await readJsonFile(indexPath);
        if (current.claimToken === claimToken) await unlink(indexPath);
      } catch {}
      throw error;
    }
  }
}

/**
 * @param {{
 *   root: string,
 *   sessionId: string,
 *   jobId: string,
 *   now?: () => string,
 *   staleMs?: number,
 * }} options
 */
export async function claimSessionLock(options) {
  if (typeof options.sessionId !== "string" || !options.sessionId) {
    throw lockError("invalid-session-id", "sessionId must be a non-empty string");
  }
  const jobId = jobIdSchema.parse(options.jobId);
  const now = options.now ?? (() => new Date().toISOString());
  const staleMs = options.staleMs ?? SESSION_STALE_MS;
  const sessionHash = createHash("sha256").update(options.sessionId).digest("hex");
  const directory = path.join(options.root, "locks", "sessions");
  const lockPath = path.join(directory, `${sessionHash}.json`);

  while (true) {
    const record = {
      jobId,
      sessionHash,
      ownerPid: process.pid,
      acquiredAt: now(),
    };
    try {
      await createJsonExclusive(lockPath, record);
      return record;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }

    const existing = await readJsonFile(lockPath);
    jobIdSchema.parse(existing.jobId);
    if (existing.jobId === jobId) return existing;

    try {
      const holder = await readJobState(options.root, existing.jobId);
      if (isTerminalJobStatus(holder.status)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
    } catch (error) {
      if (error?.reason !== "job-not-found") throw error;
      const age = Date.now() - Date.parse(existing.acquiredAt || "");
      if (Number.isFinite(age) && age > staleMs && !processIsAlive(existing.ownerPid)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
    }

    throw lockError(
      "session-busy",
      `session is already in use by job ${existing.jobId}`,
      { jobId: existing.jobId }
    );
  }
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {string} jobId
 */
export async function releaseSessionLock(root, sessionId, jobId) {
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  const lockPath = path.join(root, "locks", "sessions", `${sessionHash}.json`);
  let existing;
  try {
    existing = await readJsonFile(lockPath);
  } catch (error) {
    if (error?.reason === "lock-not-found") return false;
    throw error;
  }
  if (existing.jobId !== jobId) return false;
  await unlink(lockPath).catch(() => {});
  return true;
}
