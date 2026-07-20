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

While a turn is running, a `still working — <elapsed>, last agent frame <age> ago, running: <tool>`
heartbeat is emitted periodically. A large frame age is normal during a long shell command; it is
not by itself a sign of trouble.

## Timeouts

cursor-agent does not stream shell output over ACP: a command emits nothing until it exits, so
mid-turn silence carries no information about liveness. The bridge therefore reports silence
rather than acting on it.

| Guard | Default | Scope |
| ----- | ------- | ----- |
| Handshake deadline | 60 s | Spawn through session setup only, where silence really does mean a wedged agent. |
| Hard cap | 1 h | Whole delegation, absolute. |
| Mid-turn idle guard | off | Opt-in; silence during a turn does not settle the session. |

Overrides: `CURSOR_DELEGATE_HANDSHAKE_MS`, `CURSOR_DELEGATE_HARD_CAP_MS`,
`CURSOR_DELEGATE_IDLE_MS` (unset or `0` = disabled). Agent process exit is detected directly and
fails fast regardless of these.

A delegation is still cancellable at any time via the `cancel` tool or a host interrupt.

The orchestrator runs long verification itself (SKILL.md step 3) — it sees full command
output, while a delegated command reports only after it exits.
