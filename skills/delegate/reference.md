# delegate tool reference

Architecture: MCP host → MCP `delegate` → cursor-delegate-mcp → **cursor-agent** over ACP.

## Input

| Field | Default | Description |
| ----- | ------- | ----------- |
| `spec` | — | Inline task brief (default). Path detection is automatic, not opt-in: a single-line `spec` that is itself an existing file path is replaced by that file's contents. A brief that merely *mentions* a path is unaffected. |
| `mode` | `agent` | `agent`, `plan`, or `ask`. |
| `model` | `composer-2.5` | Bare ACP family id (`composer-2.5`, `grok-4.5`, `gpt-5.4`). Rejected before the turn starts if the agent does not offer it; the error names the ids it does. |
| `fast` | `false` | `false` = standard tier; `true` = higher costs — ONLY when user asks. Always sent, so `false` turns it off on a resumed session. |
| `workspace` | server cwd | Working directory for the agent. The default is the **MCP server process's** cwd, which for `npx`/plugin launches is not necessarily your project root — pass it explicitly. |
| `resumeSessionId` | — | Resume an existing ACP session. |
| `reasoning` | — | Reasoning effort, forwarded as an ACP config option. gpt-5.x accepts `none`, `low`, `medium`, `high`, `extra-high`. |
| `context` | — | Context window size, same channel. gpt-5.x accepts `272k` and `1m`. |
| `contextFiles` | — | Paths to attach instead of pasting contents into `spec`. Text files become `resource_link`s the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against `workspace` but are **not restricted to it**. Skips are reported in `protocolWarnings`, never fatal. |

The ACP model namespace is not the CLI's. `session/new` advertises bare family ids, while
`cursor-agent --list-models` prints tier-suffixed variants (`cursor-grok-4.5-high`,
`gpt-5.4-high`, `composer-2.5-fast`). Over ACP the tier is a config option instead, so the
CLI's `gpt-5.4-high` is `model: "gpt-5.4"` plus `reasoning: "high"`, and any `-fast` suffix
is `fast: true`. Passing a suffixed id fails with `Invalid model value`. `doctor` with
`deep: true` prints the list this agent actually offers.

Which config options a model offers is not discoverable up front, so `reasoning` and
`context` are sent and the rejection is read as the answer: a model without the knob yields
a `protocolWarnings` note and the run continues, while an invalid value for a knob the model
*does* have fails the call. Do not pass them speculatively.

## Return value

| Field | Description |
| ----- | ----------- |
| `result` | Final agent text: the complete stream for tool-free turns, or only text emitted after the final tool completes. Empty when no final message was emitted. Capped at 10MB, with a trailing `[output truncated at 10MB]` marker. |
| `resultSource` | Present only as a caveat on `result`; **absent on the happy path**, where `result` is simply the answer. `"pre-tool-fallback"` (no final message closed the turn; `result` is the last message before the agent's final tool call — read `protocolWarnings` before trusting it), `"plan-detail"` (plan/ask only: the chat message was too terse to be the plan, so `result` carries the plan the agent filed), or `"none"` (no message; `result` is empty). A refusal is not a caveat here — it ends the turn cleanly and its text is the `result`; judge by the diff. |
| `stopReason` | ACP stop reason (e.g. `end_turn`). |
| `sessionId` | Session id for resume. |
| `filesReportedByAgent` | Files the agent reported editing (native ACP diff events). Not a complete change record — shell-driven edits may be absent; the git diff is authoritative. |
| `questionsAsked` | Prompts surfaced via `cursor/ask_question`. In practice **always empty**: cursor-agent has never been measured emitting that request, so clarifying questions arrive as ordinary text in `result`. |
| `resumed` | Present and **`true` only** when a resume took (the returned session id matched `resumeSessionId`). Absent for a fresh session or a failed resume — a failed resume is explained in `protocolWarnings`. |
| `sessionTitle` | Short title the agent gave this turn. A label for telling concurrent delegations apart; also named in timeout errors. |
| `modeChanged` | `{from, to}`, set when the agent switched itself out of the requested mode. A `plan` run that becomes `agent` is **write-capable** — inspect the diff before reporting a plan-only outcome. Absence proves nothing; see Mode behavior. |
| `writeCapableActivity` | Write-capable tool calls (`edit`/`delete`/`move`/`execute`) run during a `plan` or `ask` turn, each with the tool's own label and, when a diff frame named one, the `path` it touched. **Only populated for `plan` and `ask`** — in `agent` mode every turn would fill it, so it carries no signal there and is omitted. It records what the agent **ran**, not what changed: a shell command is not a change list, and an entry without a `path` may be a no-op or a retry that changed nothing. Treat the count as an upper bound on writes, never a total. |
| `cancelRequested` | `true` when a cancel was issued mid-run. Distinguishes a clean finish from one where the agent ignored the cancel and completed anyway. |
| `todos` / `todoProgress` | The agent's own task list and its counts. See the caveat below. |
| `autoAnswered` | Present on non-elicitation clients using the default first-option fallback (`prompt`, `chosen`). |
| `fallbackAnswers` | Present when a free-text answer matched no option: the user's answer was **discarded** and the first option submitted instead (`prompt`, `given`, `chosen`). Treat it like `autoAnswered` — an unconfirmed choice worth checking against the brief. |
| `plan` | Present when a plan was emitted (plan mode). |
| `protocolWarnings` | Non-fatal diagnostics that did not justify failing the call. Read it whenever it is present. |

`autoAnswered` and `fallbackAnswers` depend on the same `cursor/ask_question` path as
`questionsAsked`, so they are equally unlikely to appear today.

### `todos` / `todoProgress` — absence means nothing

Both fields are **omitted entirely** when the agent tracked no todos, rather than reported as
zeros. Most correct, complete turns emit no todo frames at all — short tasks especially. So:

- `todoProgress` present with `completed < total` is direct evidence of unfinished work.
- `todos` absent is **not** evidence of anything, and must not be read as incompleteness.

`todoProgress` is `{total, completed, inProgress, pending}`.

### `plan` object (when present)

| Field | Description |
| ----- | ----------- |
| `plan.entries` | Structured steps from `session/update:plan`. |
| `plan.overview` | One-line summary from `cursor/create_plan` (may be absent). |
| `plan.detail` | Markdown plan body from `cursor/create_plan` (may be absent). |

## Mode behavior

`mode` is set on the agent via `session/set_mode`. The bridge auto-approves **every**
`session/request_permission` regardless of mode, so read-only-ness in `plan` and `ask` is the
agent's behavior, not an enforced boundary.

In `plan` and `ask`, write-capable tool calls are reported in `writeCapableActivity` with a
`protocolWarning`. That is disclosure, not a boundary: the call is reported as it is dispatched,
never withheld. In `agent` mode nothing is reported — review the diff, as always.

`modeChanged` only fires on a `current_mode_update` frame — the agent formally switching modes.
It is **not** a signal that the mode was ignored: a measured `plan` run wrote two files via
shell while staying in `plan`, so no frame was sent and `modeChanged` stayed unset. Nothing
about that run was ignoring the mode from the protocol's point of view; the agent simply did
not honor the instruction. cursor-agent never sends `session/request_permission` for shell
work either, so there is no approval the bridge could have withheld.

- **`agent`** — implements; auto-approves writes; accepts `cursor/create_plan` if emitted.
- **`plan`** — plan only; the sole mode-dependent gate is rejecting `cursor/create_plan`
  acceptance.
- **`ask`** — read-only Q&A over the codebase, by agent convention.

## Failures

Errors come back as `delegate failed [<reason>]: …`.

| Reason | Meaning | Action |
| ------ | ------- | ------ |
| `unknown-model` | `model` is not offered by this agent; the message names the valid ids. | Fix the argument. |
| `agent-error` | The agent rejected a request (JSON-RPC error, e.g. an invalid config value). | Fix the argument; retrying is pointless. |
| `hard-cap` | The 1h absolute cap elapsed. | Resume the id in the message. |
| `idle-timeout` | Opt-in mid-turn idle guard tripped (off by default). | Resume the id in the message. |
| `agent-exit` | The agent process died; stderr is included. | Resume once; run `doctor` if it repeats. |
| `handshake-timeout` | No prompt ever went in flight — the agent wedged during setup. | Run `doctor`; there is no session to resume. |
| `aborted` | The MCP host interrupted the request (e.g. Esc in Claude Code). Usually fires mid-turn against a live session, so a `resumeSessionId` is supplied; only an abort that arrives before the session exists has none. | Deliberate, so normally stop — but resume the id if the work should continue. |

Timeout, abort and exit failures additionally name the last tool call, how long the wire has
been quiet, the turn title, todo progress, files reported edited, and a `resumeSessionId` —
plus a note if an earlier resume had already failed, meaning none of that work was in
context. The raw ACP transcript is not included: nothing in it changes what you can do, and
it is large. Set `CURSOR_DELEGATE_TRANSCRIPT=<frames>` to append it when debugging the bridge
itself. `ACP_LOG_SIZE` bounds retention (2000 frames) and so caps what this can return; at
`0` nothing is recorded and it returns nothing at all.

## Resume

Cross-process resume via `session/load`. Unknown ids fall back to a fresh session.

## Progress

Thinking, streamed response sentences, tool starts, and todo-list changes arrive as ephemeral
MCP progress notifications — separate from `result`.

While a turn is running, a `still working — <elapsed>, last agent frame <age> ago, running: <tool>`
heartbeat is emitted periodically, with a `todo i/n: …` segment when the agent tracks todos. A
large frame age is normal during a long shell command; it is not by itself a sign of trouble.

## Clarifying questions

Measured behavior: cursor-agent asks in prose and ends the turn. Answer by resuming the same
session with free text in `spec` — you are not limited to any options it listed.

The structured `cursor/ask_question` path is implemented but has never been observed firing.
When it does, hosts with MCP elicitation get a prompt; multi-select questions (`allowMultiple`)
accept several option labels comma-separated. Hosts without elicitation auto-select the first
option and disclose it in `autoAnswered` — check those against the brief's decisions.

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

## Other tools

**`cancel`** — `{sessionId, force?}` → `status: "cancelled" | "killed" | "not-found"`.
`session/cancel` is best-effort and the agent may finish the turn; the session stays
cancellable afterwards, so a follow-up call with `force: true` kills the process after a
grace period and reports `killed`. `not-found` means the delegation has already settled.

**`doctor`** — `{deep?}`. Always reports plugin version, MCP client capabilities (including
`supportsElicitation`), launcher resolution and `agent.found`, plus runtime info. With
`deep: true` it adds `agent.handshake`: `{ok, protocolVersion, agentCapabilities, models,
currentModel, modes}`, or `{ok: false, error}`. `agent.handshake.models` is the authoritative
list to check after an `unknown-model` failure.
