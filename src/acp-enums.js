// The value sets ACP allows for plan and todo fields, shared by the two layers that read them:
// the sanitizers in delegate.js, which strip anything else off an agent frame, and the zod
// schemas in server.js, which advertise them to hosts. A drift between the two would strip a
// value the tool documents, or document one it strips.
//
// Plan status follows ACP v1 PlanEntryStatus (no cancelled). Todo status follows Cursor's
// update_todos / create_plan todo arrays, which include cancelled. They stay separate
// constants so they can diverge.

export const PLAN_PRIORITIES = /** @type {const} */ (["high", "medium", "low"]);

export const PLAN_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed"]);

export const TODO_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed", "cancelled"]);
