# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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
