# delegate reference

What a result field or failure `reason` means and what to do next.

## Inputs

`model` takes a bare ACP family id, not the CLI's tier-suffixed `--list-models` strings: the
CLI's `gpt-5.4-high` is `model: "gpt-5.4"` plus `effort: "high"`, and `-fast` is `fast: true`.
`doctor` with `deep: true` lists the ids this account offers.

`effort` is matched exactly against the selected model's effort option. Values are
case-sensitive and differ per model; some models have no effort option. Do not pass `context`
speculatively.

`contextFiles` resolve against `workspace` but are not limited to it; paths outside it may
arrive unreadable on the agent side. Skipped files are reported in `protocolWarnings`.

## Result

| Field | Meaning |
| ----- | ------- |
| `result` | The final agent text: the whole stream for a tool-free turn, otherwise the text after the last tool call. In `plan` and `ask`, the plan or the answer. A clarifying question also arrives here and ends the turn; answer it by resuming with free text, not limited to the options listed. |
| `resultSource` | Absent on the happy path. `"pre-tool-fallback"`: no final message closed the turn, so `result` is the last message before the final tool call; read `protocolWarnings` before trusting it. `"none"`: no message, `result` is empty. A refusal is not a `resultSource` caveat: its text is the `result` and `stopReason` is set; judge by the diff. |
| `stopReason` | Present only when the turn did not end normally: a refusal, a cancel, or an output cap. |
| `sessionId` | Pass as `resumeSessionId` to continue. For a `delegate` run as an MCP task, the task id works too while this server process runs. |
| `resumed` | `true` only when a resume took. Absent after a fresh session or a resume that fell back; `protocolWarnings` says why, which separates a stale id from a typo. |
| `filesReportedByEditTools` | Files the agent's edit tools reported. Absent when none did, which does not mean nothing changed: shell edits leave no record. The git diff is authoritative. |
| `todoProgress` / `todos` | `{total, completed, inProgress, pending, cancelled}` when the agent tracked todos. `todos` lists the items only when `completed < total`. Both absent is the normal case and means nothing. |
| `effectiveModel` | The model the agent served, only when it differs from `model` (for example, a resume on another model). Also absent when the agent reported no model id, which some models do and `default` (Auto) always does; absence does not confirm `model` served. |
| `effectiveEffort` | The value of each effort option as the agent reported it when the prompt went out, keyed by option id: `{"reasoning_effort": "high"}`. Absent when unconfirmed; never read absence as a level. |
| `cancelRequested` | A cancel was issued mid-run. Tells a clean finish from one where the agent ignored the cancel. |
| `plan` | `agent` mode only, when the agent filed one: `{entries, overview?, detail?}`. |
| `protocolWarnings` | Non-fatal diagnostics: dropped or sanitized fields, a failed resume, ignored model options, skipped `contextFiles`. Read it whenever present. |

## Failures

Errors come back as `delegate failed [<reason>]: …`.

| Reason | Next step |
| ------ | --------- |
| `invalid-spec`, `invalid-workspace` | Fix the argument; nothing was spawned. |
| `unknown-model` | The agent does not offer `model`; the message names the ids it does. Fix `model`. |
| `invalid-effort` | No prompt was sent. With `Accepted: [...]`, retry the named session with the complete original `spec` and a listed value. With `Advertised: [...]`, no option was recognized as effort: if none of them is an effort setting, omit `effort` (do not send `"none"`); if one is, report that the bridge failed to recognize it. |
| `effort-options-unavailable` | No prompt was sent. Retry the named session once with the complete original `spec`; if it repeats, run `doctor` and report it rather than guessing a value. |
| `resume-failed` | The session could not be loaded and nothing was started. Retry, or omit `resumeSessionId` to start fresh. (A session the agent does not have is not this: it starts fresh with a `protocolWarnings` entry.) |
| `agent-error` | The agent returned a JSON-RPC error. Fix the argument if the message names one. |
| `hard-cap` | The 6 h cap elapsed. Resume the id in the message. |
| `spawn-failed` | cursor-agent could not be started. Install the Cursor CLI and run `cursor-agent login`; `doctor` shows the launcher resolution. |
| `agent-exit` | The agent process died; stderr is included. Resume once; run `doctor` if it repeats. |
| `handshake-timeout` | The agent wedged during setup. Resume the id if the message names one; otherwise, or if it repeats, run `doctor`. |

Timeout and exit failures also name the last tool call, the time since the last frame, the turn
title, todo progress, files reported edited and the `resumeSessionId`, plus a note if an earlier
resume had failed, meaning none of that work was in context.

## Running turns

cursor-agent sends nothing while a shell command runs, so mid-turn silence is normal and is not
timed out. Only the 60 s setup deadline and the 6 h cap apply.

`cancel` is advisory and the agent may finish the turn. The session stays cancellable, so call
again with `force: true` to kill the process after a grace period; a force that cannot confirm
the exit reports `cancelled`. For an MCP task, the task id reaches only that task's turn; a
session id reaches every turn on the session.
