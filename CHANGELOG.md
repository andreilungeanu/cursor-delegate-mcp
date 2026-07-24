# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.13.0] - 2026-07-24

Leaner, more honest results: four low-signal surfaces dropped, and the plan/ask reply now
comes back as the agent's own words. All breaking, all output-contract.

### Changed

- **Breaking**: in `plan`/`ask`, `result` is the agent's own message **verbatim** — the bridge
  no longer promotes the filed plan into it or folds a chat reply under a separator, and
  `resultSource: "plan-detail"` is gone. The plan travels as `plan.entries` and lives in the
  session; resume to act on it.

### Removed

- **Breaking**: `cursor/ask_question` elicitation, with `questionsAsked`, `autoAnswered`, and
  `fallbackAnswers`. cursor-agent never sends it over ACP — clarifying questions arrive as prose
  in `result`; resume with free text in `spec` to answer.
- **Breaking**: `writeCapableActivity`. It could not tell a read (`ls`) from a write, so it only
  ever cried wolf; review the git diff, which is authoritative on every run.
- **Breaking**: `modeChanged`. A `plan` run can write without a mode-switch frame, so its
  absence proved nothing and its presence just echoed the diff review you already owe every run.
- **Breaking**: the `maxResultChars` input. The always-on 10MB streaming ceiling still guards
  runaways; shape reply length through the spec.

## [1.12.0] - 2026-07-23

### Changed

- **Breaking**: the plugin-bundled MCP server key is renamed `cursor-delegate-mcp` →
  `cursor-delegate`, removing the duplicated `cursor-delegate-mcp:cursor-delegate-mcp`
  label. Update permission rules from `mcp__plugin_cursor-delegate-mcp_cursor-delegate-mcp__*`
  to `mcp__plugin_cursor-delegate-mcp_cursor-delegate__*` and restart Claude Code.
  Standalone installs (`claude mcp add` / project `.mcp.json`) are unaffected.
- **Breaking**: `filesReportedByAgent` is renamed `filesReportedByEditTools`, naming what
  it is built from — edit-tool diff events — and it is omitted when empty instead of
  returned as `[]`. Absence means no edit tool reported a change, not that nothing
  changed; the git diff remains authoritative.
- **Breaking**: `resultSource` is emitted only as a caveat (`pre-tool-fallback`,
  `plan-detail`, `none`) and `resumed` only when a resume actually took;
  `finalMessageAvailable` is dropped — it restated `resultSource` as a boolean.
- **Breaking**: `sessionTitle` is no longer in the result — it arrived after the turn and
  could contradict the answer. It now shows as a `turn titled: …` progress notification
  while the turn runs; timeout forensics still name it.
- **Breaking**: `todos` is returned only when `todoProgress` shows unfinished work; on a
  fully-completed turn `todoProgress` alone carries the counts. Timeout forensics and the
  `todo i/n` heartbeat are unchanged.
- The skill reference is trimmed to contract facts per the 2026-07-23 audit ruling; all
  tables are unchanged.

### Fixed

- Skill reference: the `stopReason` and `plan.detail` rows now match the 1.11.x omission
  behavior, and the `cancel` status list includes `not-running` (added in 1.11.0).
- The `writeCapableActivity` warning no longer says "the diff for what changed" when no
  entry reported a path — it now says to check the diff to confirm nothing changed.
- Idle-timeout failures now advise raising `CURSOR_DELEGATE_IDLE_MS` instead of
  `CURSOR_DELEGATE_HARD_CAP_MS`, which does nothing for the idle guard.
- Spawn failures are tagged `[spawn-failed]` like every other failure class, instead of a
  bare `delegate failed:` with no reason.

## [1.11.1] - 2026-07-22

### Changed

- `plan.detail` handling is now a one-plan contract: in `plan`/`ask` it is dropped when
  `result` is a real plan message, or folded into `result` (reported as
  `resultSource: "plan-detail"`) when the message is too terse to be the plan; in `agent` mode
  it is kept alongside the implementation report. Replaces the earlier length comparison.
- Documented that `writeCapableActivity` `kind` is what a tool could do, not proof it wrote (an
  `execute` entry may be read-only), and that `ask` holds across models where `plan` compliance
  varies.

## [1.11.0] - 2026-07-22

### Added

- `maxResultChars` delegate input caps the returned result: a longer result is truncated
  with a marker and a `protocolWarning`, so a runaway reply cannot blow up the caller's
  context and the cut is never mistaken for a complete answer.
- `cancel` reports `not-running` for a session whose turn has ended (still resumable via
  `resumeSessionId`), distinct from `not-found` for an id never seen this process — the two
  used to look identical.

### Changed

- The response drops fields that carried no signal: `stopReason` is omitted unless it is
  something other than the usual `end_turn`, and `questionsAsked` is omitted until
  elicitation actually populates it.
- `plan.detail` is no longer returned when `result` already carries the plan — it duplicated
  the same prose. It is kept only when `result` is too terse to be the plan itself;
  `plan.entries` and `plan.overview` are unchanged.
- `contextFiles` are deduplicated by resolved path, so equivalent entries are sent once.
- The session id is emitted in an early progress notification, giving a host that can call
  tools concurrently an id to pass to `cancel` while the turn is still running.
- **Breaking:** a blank or whitespace-only `spec` is rejected before a session starts,
  instead of spending a live turn on a "No prompt content provided" reply.

### Fixed

- `doctor` reads the plugin version fresh on each call instead of a value captured at process
  start, so it reflects an in-place upgrade rather than reporting the old version until a
  full client restart.

## [1.10.0] - 2026-07-21

Two input validations change behavior: calls that used to succeed by accident now fail
instead. They are called out as breaking below.

### Added

- `contextFiles` delegate input: paths attached to the prompt instead of pasted into `spec`.
  Text files are sent as `resource_link` blocks the agent may open; images (png/jpg/gif/webp
  under 5MB) are sent inline, gated on the agent advertising `promptCapabilities.image`.
  Relative paths resolve against `workspace` but are not confined to it, and anything skipped
  lands in `protocolWarnings`.
- `writeCapableActivity` — write-capable tool calls (`edit`/`delete`/`move`/`execute`) made
  during a `plan` or `ask` turn, each with the path when a diff frame named one, plus a
  `protocolWarning`. It records what the agent **ran**, not what changed: a shell command is
  not a change list, and an entry without a path may be a no-op or a retry. Not populated in
  `agent` mode, where every turn would fill it and it would carry no signal.

### Changed

- **Breaking:** `workspace` must exist and be a directory. A missing path was accepted and
  then created by the agent's first write, so a typo silently spawned a parallel empty tree
  that looked like success at every layer.
- **Breaking:** a `spec` that is a bare path now fails when nothing is there or it is not a
  file, instead of being handed to the agent as literal prompt text and spending a live turn.
  Prose that merely names a file ("fix the bug in src/api.js") is unaffected.
- `SERVER_INSTRUCTIONS` no longer claims `modeChanged` is the signal that a mode was ignored.
  It fires only on a formal mode switch, and an agent that writes while staying in `plan`
  sends no such frame — so the field cannot detect the case it was cited for. The skill and
  its reference say the same.
- Failure messages no longer carry the raw ACP transcript: up to 40 frames of JSON-RPC in the
  caller's context on every failure, none of it actionable beside the structured forensics.
  Set `CURSOR_DELEGATE_TRANSCRIPT=<frames>` to append it when debugging the bridge itself.
- The delegate skill asks Cursor to run tests as it works instead of discouraging it, and
  briefs now ask for gaps back: unmet acceptance criteria and assumptions made.
- Documented that ACP model ids are the bare family (`grok-4.5`), not the CLI's tier-suffixed
  `--list-models` strings, which `session/set_model` rejects. Over ACP the tier is `fast` or
  `reasoning`, so the CLI's `gpt-5.4-high` is `model: "gpt-5.4"` with `reasoning: "high"`.
- The skill and its reference document the surface added since 1.7.0, and correct three
  things they described wrongly: `protocolWarnings` is a general soft-diagnostic channel,
  `plan`/`ask` are requests to the agent rather than boundaries, and `questionsAsked` is
  effectively always empty.

### Fixed

- A turn whose final message is followed by one more tool call no longer returns `""` shaped
  like success. The discarded message comes back as `resultSource: "pre-tool-fallback"` with
  a `protocolWarning`, and a real final message always wins over it. A turn that emitted no
  message at all still returns `""`, now with a warning rather than silence.
- A handshake timeout now names the frame age and the resumable `sessionId`. The session
  exists before `set_model`, `set_config_option` and `set_mode`, any of which can hang, so
  callers were losing resumable work. It does not get the long-running-command advice — no
  prompt was ever sent.
- `cancel` no longer drops its session handle on the non-force path, which made the natural
  escalation — cancel, wait, cancel with `force` — report `not-found` while the agent was
  still alive.

## [1.9.0] - 2026-07-21

### Added

- `reasoning` and `context` delegate inputs, forwarded as ACP config options (gpt-5.x
  accepts `none`/`low`/`medium`/`high`/`extra-high` and `272k`/`1m`). Which options a
  model offers is not discoverable up front, so the bridge asks and reads the rejection:
  a model without the knob yields a `protocolWarnings` note, an invalid value still errors.
- `sessionTitle` — the short title the agent gives the turn, also named in timeout errors.
- `modeChanged` — set when the agent switches itself out of the requested mode, e.g. a
  plan-mode run that becomes write-capable.

### Changed

- `fast` is offered to every model instead of only bare `composer-*` ids, and is always
  sent so `false` can turn it off on a resumed session. Models without the toggle report
  it as ignored rather than silently dropping it.
- A failed resume no longer starts a fresh session silently: the reason lands in
  `protocolWarnings`, and timeout errors say the earlier work was never in context.
- Delegate failures are tagged with their reason, e.g. `delegate failed [agent-error]: …`,
  so a rejected argument is distinguishable from a timeout without parsing prose.

### Fixed

- JSON-RPC errors keep the error code and the nested `data.message`, so a rejection reads
  as `Invalid params: Unknown model config option: reasoning` instead of `Invalid params`.
- Frames replayed by `session/load` are ignored until the prompt is in flight — a resume
  no longer reports the previous turn's tool calls and edits as if they were happening now.
- Multi-select `ask_question` (`allowMultiple`) is answered with every option the user
  names, comma-separated; single-select labels containing a comma still match whole; a
  question with no options answers empty instead of emitting a null option id.

## [1.8.0] - 2026-07-21

### Added

- Delegate results carry `todos` and `todoProgress`: the agent's own task list,
  accumulated from `cursor/update_todos`, also surfaced in progress updates and the
  heartbeat so a long run shows what is left rather than only that it is alive.
- `doctor --deep` reports the negotiated capability matrix — protocol version, agent
  capabilities, available models and modes.

### Changed

- **Timeouts.** The prompt-phase idle timer is gone: cursor-agent emits no ACP frames
  while a shell command runs, so a healthy 2-minute test suite was indistinguishable
  from a hang and got killed after the work was done. It is replaced by a 60s handshake
  deadline covering spawn through session setup, where silence really does mean a wedged
  agent; the 1h hard cap and agent-exit detection are unchanged. A periodic
  `still working — <elapsed>, last agent frame <age> ago, running: <tool>` heartbeat
  makes a long command visible, and timeout errors name the last tool call and how long
  the wire has been quiet. New overrides: `CURSOR_DELEGATE_HANDSHAKE_MS`,
  `CURSOR_DELEGATE_HARD_CAP_MS`, `CURSOR_DELEGATE_IDLE_MS` (unset or `0` disables
  mid-turn idle detection).
- `touchedFiles` is replaced by `filesReportedByAgent`, built from the agent's own ACP
  diff events instead of inferred from the working tree — no false positives from
  unrelated edits, and nothing reported that the agent did not claim.
- An unknown `model` is rejected before the turn starts, naming the ids the agent
  actually offers, instead of failing later inside `session/set_model`.
- Process termination uses an immediate cross-platform tree kill instead of a
  signal-escalation ladder, so no orphaned child survives a cancel on Windows.

## [1.7.0] - 2026-07-16

### Added

- Delegate results now carry `cancelRequested: true` when a cancel was issued
  mid-run, so hosts can tell a genuinely clean finish from one where the agent
  ignored the cancel and completed the turn anyway.
- `cancel` tool gains a `force` option: after sending `session/cancel`, it waits
  a short grace period and, if the turn is still running, kills the agent process
  (tree-kill on Windows). Reports `status: "killed"` when it does.

### Changed

- Aborting the MCP delegate request (host interrupt, e.g. Esc in Claude Code)
  now terminates the agent process instead of leaving it running until the idle
  timeout. The delegation rejects promptly with reason `aborted`.
- `cancel` tool description states the honest contract: `session/cancel` is
  best-effort and the agent may finish the turn; serialized MCP hosts cannot run
  it while a delegation is in flight.

### Fixed

- Empty or whitespace-only `model` values are rejected with a clear validation
  error before any agent process starts, instead of failing mid-handshake with a
  transcript dump. Provided model ids are trimmed.

## [1.6.0] - 2026-07-11

### Changed

- Default ACP launcher is `cursor-agent acp` instead of bare `agent acp`, avoiding
  PATH collisions with other CLIs (e.g. Grok Build) that also ship an `agent` command.
  Error messages and docs now reference `cursor-agent` throughout.

## [1.5.0] - 2026-07-11

### Added

- ChatGPT/Codex and GitHub Copilot plugin manifests and marketplace catalogs,
  alongside the existing Claude Code plugin. Non-Claude installs launch the
  published npm package through `npx`.
- MCP server instructions, formal tool output schemas with `structuredContent`,
  tool annotations, and `doctor` runtime diagnostics (Node version, platform,
  arch, cwd, transport).
- `protocolWarnings` in delegate results: malformed ACP plan frames and
  non-string stop reasons are dropped with an explicit diagnostic instead of
  failing the MCP call after the delegation already ran.
- CI: cross-platform test matrix plus a minimum-dependency job that runs the
  suite against the declared `@modelcontextprotocol/sdk` floor.

### Changed

- Claude-only configuration moved out of cross-host auto-discovery paths:
  the plugin MCP config lives at `.claude-plugin/mcp.json` and the SessionStart
  hook config at `.claude-plugin/hooks.json`, both referenced from the plugin
  manifest. This keeps Copilot from picking up the bundled-server config and
  Codex from auto-discovering the Claude bootstrap hook.
- Minimum `@modelcontextprotocol/sdk` raised to `^1.22.0`; older versions
  cannot serialize the tool output schemas.
- The npm package is runtime-only (`src/`, README, LICENSE, legal files);
  plugin manifests, skills, and assets ship via Git installs.

### Documentation

- Setup paths for Codex, GitHub Copilot, VS Code, JetBrains AI Assistant,
  Windsurf, Visual Studio, and Cursor, with host statuses stated factually
  (packaged and contract-tested vs. documented configuration).

## [1.4.0] - 2026-07-10

### Fixed

- `result` no longer mixes mid-task code and narration into the final response.
  Turns that used tools return only the agent's message after its last tool
  call; tool-free turns still return the complete response.

### Added

- `resultSource` (`"post-tool"`, `"tool-free-stream"`, or `"none"`) and
  `finalMessageAvailable` response fields. When the agent finishes its tools
  without a final message, `result` is empty — check `touchedFiles` and the
  diff instead of trusting intermediate text.

## [1.3.0] - 2026-07-03

### Changed

- Progress notifications are now readable status lines: streamed thinking and
  response chunks are assembled into complete sentences (cursor-agent emits
  back-to-back sentences with no separator), each stream reports at most one
  line per ~2s (newest wins), and markdown structure (table rows, headings,
  fences, bullets) is filtered out of progress.
- `running:` progress lines include the tool's file path when cursor-agent
  provides a location (it currently sends none; ready for when it does).

### Fixed

- Progress messages are no longer silently dropped: the server-side 100ms
  notification throttle discarded the newest status line when updates arrived
  in bursts.

## [1.2.0] - 2026-07-01

### Fixed

- Windows: successful delegations no longer leave an orphaned cursor-agent
  process behind — `stop()` now kills the full process tree (previously only the
  shell wrapper died; tree-kill applied only on timeout escalation).

### Changed

- `delegate` tool `fast` parameter is now a real boolean (was the string enum
  `"false"`/`"true"`); conversion to the string ACP expects happens at the
  protocol boundary.

### Added

- `fallbackAnswers` result field: when a free-text elicitation answer matches no
  offered option, the first option is submitted and the mismatch is reported
  (`prompt`, `given`, `chosen`) instead of being silently discarded.
- `ACP_AGENT_ARGS` supports quoted arguments containing spaces; environment
  variables are now documented in the README.
- Clear startup error on unsupported Node versions (requires Node 22+).

## [1.1.0] - 2026-06-29

### Added

- Distributable as a standalone MCP server via `npx cursor-delegate-mcp` (`bin`
  entry) for any compatible client, alongside the Claude Code plugin.
- Auto-answer fallback for clients without MCP elicitation: the recommended option
  is selected and reported in the new `autoAnswered` result field.

## [1.0.0] - 2026-06-28

First public release.

### Added

- Claude Code plugin that delegates coding tasks to **cursor-agent** over the
  [Agent Client Protocol](https://cursor.com/docs/cli/acp).
- **`delegate`** tool — spec file or inline task, agent/plan/ask modes, session
  resume, structured result (`touchedFiles`, `sessionId`, optional `plan`).
- **`doctor`** tool — plugin and cursor-agent setup diagnostics.
- **`cancel`** tool — best-effort cancellation of an in-flight delegation.
- Default model **Composer 2.5** standard tier (`fast: false`); other Cursor models
  available on request.
- Auto-approved file writes; `cursor/ask_question` surfaced via MCP elicitation.
- Git-derived `touchedFiles` when the workspace is a repo; ephemeral progress for
  thinking and tool activity.
- **`delegate`** plugin skill — orchestration playbook for Claude (when to delegate, plan/resume workflow, verification).
