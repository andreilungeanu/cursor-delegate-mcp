// Allowed plan and todo values, shared by delegate.js's sanitizers and server.js's schemas so the
// two cannot drift. Plan status follows ACP v1 PlanEntryStatus (no cancelled); todo status follows
// Cursor's update_todos and create_plan arrays, which include cancelled.

export const PLAN_PRIORITIES = /** @type {const} */ (["high", "medium", "low"]);

export const PLAN_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed"]);

export const TODO_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed", "cancelled"]);
