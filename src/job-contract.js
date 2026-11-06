import { z } from "zod";

export const JOB_STATUSES = Object.freeze([
  "queued",
  "starting",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {unknown} value */
export function isJobStatus(value) {
  return typeof value === "string" && JOB_STATUSES.includes(value);
}

/** @param {unknown} status */
export function isTerminalJobStatus(status) {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

export const jobIdSchema = z.string().regex(UUID_V4_RE, "jobId must be a UUID v4");

export const waitInputSchema = z.object({
  jobId: jobIdSchema,
  afterRevision: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().min(0).max(30_000).default(20_000),
});

export const JOB_SNAPSHOT_FIELDS = Object.freeze([
  "jobId",
  "status",
  "revision",
  "clientRequestId",
  "sessionId",
  "phase",
  "createdAt",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "heartbeatAt",
  "lastActivityAt",
  "lastToolLabel",
  "todoProgress",
  "filesReportedByEditTools",
  "cancelRequested",
  "localTermination",
  "remoteTermination",
  "errorSummary",
]);

/**
 * Return only the persisted fields that form the public lifecycle contract. The request,
 * environment, protocol transcript, and runner credentials never cross this boundary.
 *
 * @param {Record<string, any>} state
 */
export function publicJobSnapshot(state) {
  /** @type {Record<string, any>} */
  const snapshot = {};
  for (const field of JOB_SNAPSHOT_FIELDS) {
    if (Object.hasOwn(state, field)) snapshot[field] = state[field];
  }
  return snapshot;
}
