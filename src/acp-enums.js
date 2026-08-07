// The value sets ACP allows for plan and todo fields, shared by the two layers that read them:
// the sanitizers in delegate.js, which strip anything else off an agent frame, and the zod
// schemas in server.js, which advertise them to hosts. A drift between the two would strip a
// value the tool documents, or document one it strips.
//
// Plan status and todo status carry the same three values today but stay separate constants:
// ACP treats them as separate enums and they are free to diverge.

export const PLAN_PRIORITIES = /** @type {const} */ (["high", "medium", "low"]);

export const PLAN_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed"]);

export const TODO_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed"]);
