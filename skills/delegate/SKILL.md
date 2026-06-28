---
name: delegate
description: >
  Delegate implementation to Cursor via the cursor-acp-bridge MCP delegate tool.
  Use when the user says delegate to Cursor, Composer, or cursor-agent; use
  Composer/Cursor for coding; hand off implementation; plan before building; or
  resume a delegation session. Do not shell out to cursor-agent — use the delegate MCP tool.
---

# Delegate to Cursor

You orchestrate; Cursor implements. Use the **cursor-acp-bridge** MCP server — never run
`cursor-agent` from the shell.

## When to delegate

Delegate when the user wants Cursor to edit the repo (they may say **Cursor**,
**Composer**, or **cursor-agent** — same handoff). Not for Claude Code subagents —
use the `delegate` MCP tool to reach cursor-agent only.

Do it yourself when the change is tiny, purely advisory (`mode: "ask"`), or the user only
wants a plan with no file writes (`mode: "plan"`).

## Workflow

1. **Build the brief inline** — pass structured task text in `spec` (goal, files in scope,
   acceptance criteria). This is the default; do not create a spec file unless the user
   wants one saved in the repo or the brief is very long.
2. **Call `delegate`** on the cursor-acp-bridge MCP server with that text in `spec`.
3. **Review** — read `touchedFiles`, inspect the git diff, run tests/lint.
4. **Report** — summarize what changed and whether acceptance criteria are met.

For field-level API detail, read [reference.md](reference.md) in this skill directory.

## Defaults


| Parameter   | Default        | Notes                                              |
| ----------- | -------------- | -------------------------------------------------- |
| `mode`      | `agent`        | `plan` = plan only; `ask` = read-only Q&A          |
| `model`     | `composer-2.5` | Default model; Composer 2.5 standard tier          |
| `fast`      | `"false"`      | `"true"` = higher costs — ONLY when user asks      |
| `workspace` | current cwd    | Scope to the smallest directory that fits the task |


Other models (Opus, Codex, etc.) are available — pass `model` when the user requests one.
Use bare model ids (e.g. `composer-2.5`), not exploded `--list-models` strings.

## Plan mode

1. `delegate(spec, mode="plan")` → save `sessionId` and read `plan` from the response.
2. Present the plan to the user; wait for approval or change requests.
3. `delegate("implement the approved plan", mode="agent", resumeSessionId=<sessionId>)`
  — or resume with explicit change requests in the spec.

## Resume vs new session

- **New session (default):** wrong approach, failed run, or substantial rework — pass a fresh inline brief.
- **`resumeSessionId`:** only when the prior run was on the right track and needs a small
clarification or follow-up in the same session. Unknown or stale ids fall back to a new session.

## Clarifying questions

If Cursor asks mid-run, the bridge surfaces it via MCP elicitation — answer through the
normal prompt flow, then delegation continues.

## Security

Delegation **auto-approves file writes** under `workspace`. Treat every call like granting
write access to that tree. Do not point `workspace` at `$HOME` or `/`. 

## Other MCP tools

- **`doctor`** — setup diagnostics when the user asks or delegation fails (`agent.found`, version, elicitation; `deep: true` for handshake).
- **`cancel`** — best-effort cancel by `sessionId` (MCP calls are serialized; often delegate must finish first).
