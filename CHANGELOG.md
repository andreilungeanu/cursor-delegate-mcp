# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
