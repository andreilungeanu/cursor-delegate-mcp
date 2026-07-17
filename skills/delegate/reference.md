# delegate tool reference

Architecture: MCP host → MCP `delegate` → cursor-delegate-mcp → **cursor-agent** over ACP.

## Input

| Field | Default | Description |
| ----- | ------- | ----------- |
| `spec` | — | Inline task brief (default). Optional file path if user wants a persisted spec. |
| `mode` | `agent` | `agent`, `plan`, or `ask`. |
| `model` | `composer-2.5` | Model id. |
| `fast` | `false` | `false` = standard tier; `true` = higher costs — ONLY when user asks |
| `workspace` | cwd | Working directory for the agent. |
| `resumeSessionId` | — | Resume an existing ACP session. |

## Return value

| Field | Description |
| ----- | ----------- |
| `result` | Final agent text: the complete stream for tool-free turns, or only text emitted after the final tool completes. Empty when no final message was emitted. |
| `resultSource` | How `result` was selected: `"tool-free-stream"`, `"post-tool"`, or `"none"`. |
| `finalMessageAvailable` | Whether Cursor emitted final agent text for this turn. When false, inspect `filesReportedByAgent`, the diff, and tests without assuming success. |
| `stopReason` | ACP stop reason (e.g. `end_turn`). |
| `sessionId` | Session id for resume. |
| `filesReportedByAgent` | Files the agent reported editing (native ACP diff events). Not a complete change record — shell-driven edits may be absent; the git diff is authoritative. |
| `questionsAsked` | List of clarifying-question prompts surfaced. |
| `resumed` | Whether `resumeSessionId` was honored. |
| `autoAnswered` | Present on non-elicitation clients using the default first-option fallback (`prompt`, `chosen`). |
| `fallbackAnswers` | Present when a free-text answer matched no option: the first option was submitted instead (`prompt`, `given`, `chosen`). |
| `plan` | Present when a plan was emitted (plan mode). |
| `protocolWarnings` | Present when malformed ACP data (plan entries, stop reason) was dropped instead of failing the call. |

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

Thinking, streamed response sentences, and tool starts arrive as ephemeral MCP progress
notifications — separate from `result`.
