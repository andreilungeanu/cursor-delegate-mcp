# delegate tool reference

Architecture: Claude Code → MCP `delegate` → cursor-acp-bridge → **cursor-agent** over ACP.

## Input

| Field | Default | Description |
| ----- | ------- | ----------- |
| `spec` | — | Inline task brief (default). Optional file path if user wants a persisted spec. |
| `mode` | `agent` | `agent`, `plan`, or `ask`. |
| `model` | `composer-2.5` | Model id. |
| `fast` | `"false"` | `"false"` = standard tier; `"true"` = higher costs — ONLY when user asks |
| `workspace` | cwd | Working directory for the agent. |
| `resumeSessionId` | — | Resume an existing ACP session. |

## Return value

| Field | Description |
| ----- | ----------- |
| `result` | Agent text for this turn (reasoning is progress-only, not included). |
| `stopReason` | ACP stop reason (e.g. `end_turn`). |
| `sessionId` | Session id for resume. |
| `touchedFiles` | Paths changed during the run. |
| `touchedFilesSource` | `"git"` (delta from `git status`) or `"diff-only"`. |
| `questionsAsked` | Count of clarifying questions surfaced. |
| `resumed` | Whether `resumeSessionId` was honored. |
| `plan` | Present when a plan was emitted (plan mode). |

### `plan` object (when present)

| Field | Description |
| ----- | ----------- |
| `plan.entries` | Structured steps from `session/update:plan`. |
| `plan.overview` | One-line summary from `cursor/create_plan` (may be absent). |
| `plan.detail` | Markdown plan body from `cursor/create_plan` (may be absent). |

## Mode behavior

- **`agent`** — implements; auto-approves writes; accepts `cursor/create_plan` if emitted.
- **`plan`** — plan only; rejects file-changing plan acceptance paths.
- **`ask`** — read-only Q&A over the codebase.

## Resume

Cross-process resume via `session/load`. Unknown ids fall back to a fresh session.

## Progress

`agent_thought_chunk` and tool starts arrive as ephemeral MCP progress notifications — not
folded into `result`.
