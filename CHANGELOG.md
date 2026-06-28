# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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
