import { z } from "zod";
import { DEFAULT_MODEL } from "./delegate.js";

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

export const delegateInputSchema = z.object({
  spec: z.string().trim().min(1, "spec must not be blank").describe("Task brief: goal, scope, fixed decisions quoted exactly, acceptance criteria. Sent as written. Point at files to read rather than pasting code, or attach them with contextFiles."),
  mode: z.enum(["agent", "plan", "ask"]).default("agent").describe("agent implements; plan and ask are instructions to the agent, not limits."),
  resumeSessionId: z.string().optional().describe("Continue an existing ACP session."),
  workspace: z.string().trim().min(1, "workspace must not be blank").describe("The agent's working directory, not a limit. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call."),
  model: z.string().trim().min(1, "model must be a non-empty string").default(DEFAULT_MODEL).describe("Bare ACP family id, version included: composer-2.5, grok-4.5, claude-opus-5, gpt-5.6-sol. doctor deep:true lists every id."),
  fast: z.boolean().default(false).describe("Fast tier; higher cost — only when the user asks."),
  effort: z.string().trim().min(1).optional().describe("Exact Cursor thinking-effort value for the selected model. Values differ per model and some expose no effort option; invalid values fail before the prompt and name the accepted set. Pass only when the user asks for Cursor effort — the host's own reasoning setting is unrelated."),
  context: z.string().trim().min(1).optional().describe("Context window size; gpt-5.x accepts 272k and 1m. Do not pass speculatively."),
  contextFiles: z.array(z.string()).optional().describe("Paths to attach instead of pasting contents into spec. Text becomes references the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against workspace but are not limited to it. Skips are reported in protocolWarnings, never fatal."),
});

export const startInputSchema = delegateInputSchema.extend({
  clientRequestId: z.string().trim().min(1).max(200).optional()
    .describe("Stable caller-generated idempotency key. Reuse it when retrying an uncertain start response."),
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
