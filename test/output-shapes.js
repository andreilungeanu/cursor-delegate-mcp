import { z } from "zod";
import { PLAN_PRIORITIES, PLAN_STATUSES, TODO_STATUSES } from "../src/acp-enums.js";

// The result shapes, parsed .strict() against what each tool returns. No tool declares an
// outputSchema: it requires structuredContent too, and a host that reads both (Codex) puts the
// payload in context twice. Field meanings are in skills/delegate/reference.md.
const planEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(PLAN_PRIORITIES).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
}).passthrough();

export const delegateOutputShape = {
  result: z.string(),
  resultSource: z.enum(["pre-tool-fallback", "none"]).optional(),
  effectiveModel: z.string().optional(),
  effectiveEffort: z.record(z.string(), z.string()).optional(),
  stopReason: z.string().optional(),
  sessionId: z.string(),
  filesReportedByEditTools: z.array(z.string()).optional(),
  resumed: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  protocolWarnings: z.array(z.string()).optional(),
  plan: z.object({
    entries: z.array(planEntrySchema),
    overview: z.string().optional(),
    detail: z.string().optional(),
  }).optional(),
  todos: z.array(z.object({
    id: z.string(),
    content: z.string(),
    status: z.enum(TODO_STATUSES).optional(),
  })).optional(),
  todoProgress: z.object({
    total: z.number(),
    completed: z.number(),
    inProgress: z.number(),
    pending: z.number(),
    cancelled: z.number(),
  }).optional(),
};

// Relayed agent fields stay unknown, so an odd model id is a diagnostic, not a failed call. Each
// nested object is its own shape because .strict() does not look inside a nested object.
export const doctorAgentShape = {
  found: z.boolean(),
  command: z.string(),
  version: z.string().nullable(),
  error: z.string().optional(),
  latestVersion: z.string().optional(),
};

export const doctorSessionShape = {
  ok: z.boolean(),
  error: z.string().optional(),
  modes: z.array(z.unknown()).optional(),
};

export const doctorModelsShape = {
  default: z.string(),
  defaultAvailable: z.boolean().nullable(),
  current: z.unknown(),
  available: z.array(z.string()),
  // Built here, not relayed, so it gets a real type.
  currentModelOptions: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    category: z.string().optional(),
    values: z.array(z.string()),
    currentValue: z.string().optional(),
  })),
};

export const doctorOutputShape = {
  plugin: z.object({ name: z.literal("cursor-delegate-mcp"), version: z.string() }).strict(),
  client: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    protocolVersion: z.string().optional(),
  }).strict(),
  agent: z.object(doctorAgentShape).passthrough(),
  auth: z.object({ status: z.enum(["ok", "logged-out", "unknown"]), plan: z.string().optional() }).strict(),
  workspace: z.object({ path: z.string(), exists: z.boolean(), isDirectory: z.boolean() }).strict(),
  env: z.record(z.string(), z.string()).optional(),
  warnings: z.array(z.string()),
  session: z.object(doctorSessionShape).passthrough().optional(),
  models: z.object(doctorModelsShape).passthrough().optional(),
};
