# delegate tool reference

Architecture: MCP host → MCP `delegate` → cursor-delegate-mcp → **cursor-agent** over ACP.

## Input

| Field | Default | Description |
| ----- | ------- | ----------- |
| `spec` | — | The task brief, sent as written. Name files in it for the agent to read, or attach them with `contextFiles`. |
| `mode` | `agent` | `agent`, `plan`, or `ask`. |
| `model` | `composer-2.5` | Bare ACP family id (`composer-2.5`, `grok-4.5`, `gpt-5.4`). Rejected before the turn starts if the agent does not offer it; the error names the ids it does. |
| `fast` | `false` | `false` = standard tier; `true` = higher costs — ONLY when user asks. Cursor keeps the tier per model across sessions; the bridge sends it unless the session already opened on that model at that tier. |
| `workspace` | required | Working directory for the agent. Smallest directory holding the task's files; with no such directory the project root is the floor. Must already exist; never create one for the call. |
| `resumeSessionId` | — | Resume an existing ACP session. |
| `effort` | — | Exact thinking-effort value, sent under whichever option id the selected model declares. Values are case-sensitive and model-specific; some models expose no effort option. |
| `context` | — | Context window size, same channel. gpt-5.x accepts `272k` and `1m`. |
| `contextFiles` | — | Paths to attach instead of pasting contents into `spec`. Text files become `resource_link`s the agent may open; images (png/jpg/gif/webp, <5MB) are sent inline. Relative paths resolve against `workspace` but are **not restricted to it**; paths outside it may arrive unreadable agent-side. Attachments are untrusted — the bridge does not scan for prompt injection. Skips are reported in `protocolWarnings`, never fatal. |

ACP model ids are bare families, not the CLI's tier-suffixed `--list-models` strings: the
CLI's `gpt-5.4-high` is `model: "gpt-5.4"` plus `effort: "high"`, and `-fast` is
`fast: true`. A suffixed id fails with `Invalid model value`; `doctor` with `deep: true`
lists the ids this agent offers.

Config option ids and values differ per model and are known only once one is selected. The bridge
matches `effort` exactly against the selected model's live options and sends it under the id that
advertised that value. An option counts as effort when the agent marks it with ACP's
`thought_level` category, or, for an agent that sends no category, when its id or name says so
(`effort`, `reasoning`, `reasoning_effort`, `thinking`, `thought_level`). A value the effort
option does not advertise, or a model with no option recognized as effort, fails as
`invalid-effort`; a missing or unusable option list fails as `effort-options-unavailable`. Both
happen before `session/prompt`. For `invalid-effort` with `Accepted`, retry with the returned
`resumeSessionId`, the complete original `spec`, and a corrected value. With `Advertised`, no
option was recognized as effort, and the message lists what the model offers instead.
For `effort-options-unavailable`, keep the same session and complete spec but do not guess a value.
Do not pass `context` speculatively.

## Sync and durable jobs

`delegate` remains the synchronous interface. Do not use it for a turn expected to
exceed the host's tool-call deadline (Codex hosts have been observed to time out around
300 seconds); use `start` instead.

`start` accepts every `delegate` field plus optional `clientRequestId`. It persists the
request first and returns a `jobId` quickly while a detached local runner owns the Cursor
ACP process. The same idempotency key and normalized request return the original job;
the same key with a different request fails as `idempotency-conflict`. A resumed Cursor
session accepts one unfinished job at a time and reports `session-busy` with the holder
`jobId`.

Track one job with its latest revision:

```text
status(jobId)
wait(jobId, afterRevision, timeoutMs<=30000)
result(jobId)
```

`wait` reports `changed` and `timedOut`. A timeout is not failure and does not write state,
send a prompt, retry, cancel, or recover a session. Poll again with the returned revision.
`result` is `not-ready` until a terminal state, and then returns the same delegate-shaped
success payload plus `jobId` and `lifecycle`, or structured failure/cancellation/
interruption evidence.

State lives under `%LOCALAPPDATA%\cursor-delegate-mcp\jobs` on Windows or the platform
state directory on POSIX; `CURSOR_DELEGATE_STATE_DIR` overrides it. Files can contain the
brief, workspace paths, progress, and result. The bridge does not delete them automatically.
Never put credentials in briefs or context files.

`health: "stale"` is derived from an old heartbeat and process evidence; a live PID alone
does not prove the job is progressing. `interrupted` is a terminal forensic state, not
success, and is never retried automatically.

## Return value

| Field | Description |
| ----- | ----------- |
| `result` | Final agent text: the complete stream for tool-free turns, or only text emitted after the final tool completes. Empty when no final message was emitted. |
| `resultSource` | Present only as a caveat on `result`; **absent on the happy path**, where `result` is simply the answer. `"pre-tool-fallback"` (no final message closed the turn; `result` is the last message before the agent's final tool call — read `protocolWarnings` before trusting it) or `"none"` (no message; `result` is empty). A refusal is not a caveat here — it ends the turn cleanly and its text is the `result`; judge by the diff. |
| `stopReason` | Present only when it is not the ordinary `end_turn` — a refusal, a cancel, or an output cap. Absence means the turn ended normally. |
| `sessionId` | Session id for resume. |
| `effectiveModel` | The model id the agent served, present **only when it differs** from the requested `model` (e.g. a cross-model resume). Also absent when the agent reported no model; some models report none, and `default` (Auto) never reports one — it advertises no config options, so the served model is not readable. |
| `effectiveEffort` | The current value of each option recognized as effort, keyed by option id, as the agent reported it when the prompt went out — e.g. `{"reasoning_effort": "high"}`, or `{"thinking": "false", "effort": "high"}` for a model with a toggle beside a level. Present whenever known, even when `effort` was omitted: the model then runs at the level Cursor saved for it, which is not a default. Absent when the agent did not confirm a value, so never read absence as a level. |
| `filesReportedByEditTools` | Files the agent reported editing (native ACP diff events). Omitted when empty — absence means no edit tool reported a change, **not** that nothing changed: shell-driven edits leave no diff event; the git diff is authoritative. |
| `resumed` | Present and **`true` only** when a resume took (the returned session id matched `resumeSessionId`). Absent for a fresh session or a resume that fell back — the fallback is explained in `protocolWarnings`. |
| `cancelRequested` | `true` when a cancel was issued mid-run. Distinguishes a clean finish from one where the agent ignored the cancel and completed anyway. |
| `todos` / `todoProgress` | The agent's own task list and its counts. See the caveat below. |
| `plan` | Agent mode only, when the agent filed a plan. Absent in `plan`/`ask`, where `result` is the plan. |
| `protocolWarnings` | Non-fatal diagnostics that did not justify failing the call: dropped or sanitized ACP fields, a failed resume, ignored model options, skipped `contextFiles`. Read it whenever it is present. |

### `todos` / `todoProgress` — absence means nothing

Both fields are **omitted entirely** when the agent tracked no todos, rather than reported as
zeros. Most correct, complete turns emit no todo frames at all — short tasks especially. When
todos were tracked, `todoProgress` is always returned; the full `todos` list is returned
**only when `completed < total`** — on a fully-completed turn it would just restate the
counts entry by entry. Cancelled items count toward `total` but not `completed`, so they
keep the list. So:

- `todoProgress` present with `completed < total` is direct evidence of unfinished or
  cancelled work, and `todos` is present alongside it naming exactly what remains — read it
  before resuming.
- `todoProgress` present and complete means everything tracked was done; no list follows.
- Both absent is **not** evidence of anything, and must not be read as incompleteness.

`todoProgress` is `{total, completed, inProgress, pending, cancelled}`. `cancelled` is a
separate bucket (Cursor todo arrays include that status); it is not folded into `pending`.

### `plan` object (agent mode only)

| Field | Description |
| ----- | ----------- |
| `plan.entries` | Structured steps from `session/update:plan`. |
| `plan.overview` | One-line summary from `cursor/create_plan` (may be absent). |
| `plan.detail` | Markdown plan body from `cursor/create_plan` (may be absent). |

In `plan`/`ask` the whole object is dropped: `result` is the agent's own plan message, and the
plan lives in the agent's session — resume to act on it.

## Mode behavior

`mode` is set on the agent via `session/set_mode`, and the bridge auto-approves **every**
`session/request_permission` regardless of it. `plan` and `ask` describe how the agent behaves,
not what the bridge permits, so **review the git diff after every run**, whatever mode you
asked for.

- **`agent`** — implements; auto-approves writes; accepts `cursor/create_plan` if emitted.
- **`plan`** — plan only; the sole mode-dependent gate is rejecting `cursor/create_plan`
  acceptance.
- **`ask`** — read-only Q&A over the codebase, by agent convention.

## Failures

Errors come back as `delegate failed [<reason>]: …`.

| Reason | Meaning | Action |
| ------ | ------- | ------ |
| `invalid-spec` | `spec` was blank. Nothing was spawned. | Fix the argument. |
| `invalid-workspace` | `workspace` was omitted, blank, does not exist, or is not a directory. Nothing was spawned. | Fix the argument. |
| `unknown-model` | `model` is not offered by this agent; the message names the valid ids. | Fix the argument. |
| `invalid-effort` | `effort` is not an exact value the selected model's effort option advertises (`Accepted: [...]`), or no option the model advertises was recognized as effort (`Advertised: [...]`). No prompt was sent. | With `Accepted`, retry the named session with the complete original `spec` and one of those values. With `Advertised`, retrying will not help: if none of the listed options is an effort setting, omit the `effort` field entirely and do not send the string `"none"`; if one is, report that the bridge failed to recognize it. |
| `effort-options-unavailable` | The selected model did not report a usable effort option list, or rejected an option it had just advertised. No prompt was sent. | Retry the named session once with the complete original `spec`; if it repeats, run `doctor` and report the capability failure rather than guessing. |
| `resume-failed` | `resumeSessionId` could not be loaded for a reason other than the agent not having that session — no fresh session was started. | Retry; omit `resumeSessionId` to start fresh deliberately. A session the agent does not have is not this: it starts fresh and reports a `protocolWarnings` entry. |
| `agent-error` | The agent rejected a request (JSON-RPC error, e.g. an invalid config value). | Fix the argument; retrying is pointless. |
| `hard-cap` | The 1h absolute cap elapsed. | Resume the id in the message. |
| `idle-timeout` | Opt-in mid-turn idle guard tripped (off by default). | Resume the id in the message. |
| `spawn-failed` | The agent process could not be started at all (launcher missing or not executable). | Install Cursor CLI and run `cursor-agent login`; `doctor` shows the launcher resolution. |
| `agent-exit` | The agent process died; stderr is included. | Resume once; run `doctor` if it repeats. |
| `session-busy` | Another unfinished persistent job holds the requested `resumeSessionId`. | Wait for, inspect, or cancel the holder named by `holderJobId`; do not send another prompt to that session. |
| `idempotency-conflict` | A `clientRequestId` was reused with a different normalized request. | Use the original request or a new key. |
| `cleanup-failed` | Work settled, but the local Cursor CLI process was not observed to exit. | Treat the job as failed; inspect `localTermination` and process evidence before any manual recovery. |
| `runner-exited` | A previously observed runner exited without a terminal result. | Job status becomes `interrupted`; do not retry automatically. |
| `runner-not-observed` | A reserved spawn was not observed before its evidence expired. | Job status becomes `interrupted`; do not create another prompt automatically. |
| `handshake-timeout` | No prompt ever went in flight — the agent wedged during setup. Setup runs past `session/new`, so a session may already exist. | Resume the id if the message names one; run `doctor` if it names none, or if resuming repeats the stall. |
| `aborted` | The MCP host interrupted the request (e.g. Esc in Claude Code). Usually fires mid-turn against a live session, so a `resumeSessionId` is supplied; only an abort that arrives before the session exists has none. | Deliberate, so normally stop — but resume the id if the work should continue. |

Timeout, abort and exit failures additionally name the last tool call, how long the wire has
been quiet, the turn title, todo progress, files reported edited, and a `resumeSessionId` —
plus a note if an earlier resume had already failed, meaning none of that work was in
context. The raw ACP transcript is not included: nothing in it changes what you can do, and
it is large. Set `CURSOR_DELEGATE_TRANSCRIPT=<frames>` to append it when debugging the bridge
itself. `ACP_LOG_SIZE` bounds retention (2000 frames) and so caps what this can return; at
`0` nothing is recorded and it returns nothing at all.

## Resume

Cross-process resume via `session/load`. Unknown ids fall back to a fresh session; any other load
failure is `resume-failed` and starts nothing.

## Progress

Thinking, streamed response sentences, tool starts, todo-list changes, and the turn title the
agent picks (`turn titled: …`) arrive as ephemeral MCP progress notifications — separate from
`result`. The title is a live label for telling concurrent delegations apart and is also named
in timeout errors; it is not returned in the result, where it can even contradict the answer.

While a turn is running, a `still working — <elapsed>, last agent frame <age> ago, running: <tool>`
heartbeat is emitted periodically, with a `todo i/n: …` segment when the agent tracks todos. A
large frame age is normal during a long shell command; it is not by itself a sign of trouble.

## Clarifying questions

Measured behavior: cursor-agent asks in prose and ends the turn. Answer by resuming the same
session with free text in `spec` — you are not limited to any options it listed. There is no
structured question path: cursor-agent never exposes its AskQuestion tool over ACP, so the
bridge does not implement `cursor/ask_question`.

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
`CURSOR_DELEGATE_IDLE_MS` (unset or `0` = disabled). On the other two, a non-positive or
malformed value falls back to the default. Agent process exit is detected directly and fails
fast regardless of these.

A synchronous delegation is still cancellable via the legacy `cancel({sessionId, force?})`
mode. A durable job is cancelled with `{jobId, force?}`. Repeating the same request is
idempotent; force upgrades an earlier advisory request.

## Other tools

**`cancel`** — durable `{jobId, force?}` returns `jobId`, `sessionId`, lifecycle `status`,
`cancelRequested`, and separate `localTermination` / `remoteTermination` evidence. The runner
sends `session/cancel`; `force: true` may then terminate and confirm the local process exit.
`remoteTermination` stays `unknown` without a remote-specific adapter.

Legacy `{sessionId, force?}` remains compatible with
`status: "cancelled" | "killed" | "not-running" | "not-found"`.
`session/cancel` is best-effort and the agent may finish the turn; the session stays
cancellable afterwards, so a follow-up call with `force: true` kills the process after a
grace period. `killed` means the process was observed to exit; a force that cannot confirm the
exit reports `cancelled` and keeps the session cancellable, so force can be retried.
`not-running` means the turn already ended — the session is still resumable via
`resumeSessionId`; `not-found` means the id is not in this process's recent session history.

**`start` / `status` / `wait` / `result`** — the durable-job lifecycle described above.
`status`, `wait`, and `result` are read-only. `wait` accepts 0–30,000 ms and defaults to
20,000 ms; larger values are rejected.

**`doctor`** — `{deep?}`. Always reports plugin version, MCP client `capabilities`,
launcher resolution and `agent.found`, plus runtime info. With
`deep: true` it adds `agent.handshake`: `{ok, protocolVersion, agentCapabilities, models,
currentModel, currentModelOptions, modes}`, or `{ok: false, error}` — not logged in, or a
timeout. `agent.handshake.models` is the authoritative list to check after an `unknown-model`
failure; `currentModelOptions` is `{id, name?, category?, values, currentValue?}[]` for
`currentModel` only, not for a `model` you are about to pass; `protocolVersion` and `currentModel` are `null` when the agent reported
none.

`agent.version` is the launcher's `--version` output, or `null`. `found: false` means it is not
installed; `found: true` with a `null` version means it exists but did not answer, and
`agent.error` says why (e.g. the probe timed out).

## Cursor CLI compatibility

The lifecycle targets Cursor's documented ACP server: `session/new`, `session/load`,
`session/prompt`, and `session/cancel`. The `cursor-agent` name remains Cursor's official
backward-compatible alias for `agent`. Windows resolves the installed
`cursor-agent.ps1` through PowerShell instead of an implicit `cmd.exe` shell. The detached
job runner uses `process.execPath` with `shell: false`; neither path is built by string
concatenation.

Cursor also has `agent persist` sessions that survive terminal disconnects. They are useful
inside an interactive terminal but do not currently expose the JSON lifecycle or external
send-message control this MCP needs, so durable MCP jobs continue to use a separate ACP
runner.
