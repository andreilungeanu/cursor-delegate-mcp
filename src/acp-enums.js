// The value sets ACP allows for plan and todo fields. They live here because two layers read
// them: the sanitizers in delegate.js, which strip anything else off an agent frame, and the
// zod schemas in server.js, which advertise them to hosts. Kept in four hand-synced copies
// before, where a drift would have meant stripping a value the tool documents, or documenting
// one it strips.
//
// Plan status and todo status happen to carry the same three values today. They stay separate
// constants because ACP treats them as separate enums, and collapsing them would silently
// couple two things that are free to diverge.

export const PLAN_PRIORITIES = /** @type {const} */ (["high", "medium", "low"]);

export const PLAN_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed"]);

export const TODO_STATUSES = /** @type {const} */ (["pending", "in_progress", "completed"]);
