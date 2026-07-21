---
name: delegate
description: >
  Delegate implementation to Cursor via the cursor-delegate-mcp MCP delegate tool.
  Use when the user says delegate to Cursor, Composer, or cursor-agent; have Cursor
  handle or do this; offload this; send this to Composer; use Composer/Cursor for
  coding; hand off implementation; plan before building; or resume a delegation
  session. Do not shell out to cursor-agent — use the delegate MCP tool.
---

# Delegate to Cursor

You orchestrate; Cursor implements. Use the **cursor-delegate-mcp** MCP server — never run
`cursor-agent` from the shell.

## When to delegate

Delegate when the user wants Cursor to edit the repo (they may say **Cursor**,
**Composer**, or **cursor-agent** — same handoff). Not for the MCP host's own subagents —
use the `delegate` MCP tool to reach cursor-agent only.

Scale effort to the task:

- **Trivial** (one-liner, rename, typo): do it yourself — delegation overhead exceeds the task.
- **Medium** (multi-file feature or refactor): one `delegate` call.
- **Large or risky** (architecture, wide rewrites): `mode: "plan"` first; implement after approval.
- Never delegate a task you cannot write acceptance criteria for.
- Purely advisory questions → `mode: "ask"`; plan with no file writes → `mode: "plan"`.
  For these, state what form the answer or plan should take — there's no diff, so the
  output format is the deliverable.

## Workflow

1. **Build the brief inline** — pass task text in `spec` that answers all four:
   - **Goal** — the outcome, precisely.
   - **Scope** — which files/directories are in play.
   - **Decisions already made** — constraints and fixed choices the user stated or implied.
     This is what prevents wrong assumptions and clarifying questions. Transmit them
     faithfully; don't invent constraints the user didn't state.
   - **Done when** — verifiable acceptance criteria. Describe the **end state, not the
     commands that prove it** — you verify in step 3. Shell output does not cross the ACP
     wire, so a delegated test run returns Cursor's summary of it, not the run. Keep any
     command you do ask for short.

   **Point, don't paste**: reference files to read or mimic ("follow the middleware
   pattern in src/api/middleware/auth.js") instead of pasting code — Cursor reads the
   repo itself; the brief carries judgment, not content. For images, and for documents
   outside the repo, prose cannot point at all — attach those with `contextFiles`.

   **Quote, don't paraphrase**: when the user states exact values or behaviors
   (delimiters, limits, error messages, response wording, timestamp formats), carry their
   words verbatim into the brief — paraphrase silently drops decisions. Example brief:

   > Goal: per-user rate limiting on all REST endpoints. Scope: src/api/middleware/,
   > src/config/. Read src/api/middleware/auth.js first and follow that middleware
   > pattern. Decisions: sliding window, config-driven; user's words: "100 requests per
   > minute, 429 with body {"error":"rate_limited"}"; no new dependencies. Done when:
   > every endpoint is covered and a unit test for the limiter is added, with no existing
   > test changed.

   Do not create a spec file unless the user wants one saved in the repo.
2. **Call `delegate`** on the cursor-delegate-mcp MCP server with that text in `spec`.
3. **Review** — read `filesReportedByAgent`, inspect the git diff, run tests/lint **yourself**
   (you see full command output; Cursor cannot show it to you), and check the result against
   the brief's acceptance criteria.
   - If `modeChanged` is set, the run was write-capable regardless of the mode you asked
     for — review the diff before reporting a plan-only outcome.
   - If `todoProgress` is present and `completed < total`, the agent left work unfinished —
     resume rather than reporting done. Its **absence** means nothing; most turns track no
     todos at all.
   - If criteria fail: resume the **same session** with the specific failure
     ("tests X and Y fail with <error>; fix without changing the public API") — not a
     re-run of the whole brief.
   - After 2 failed resume attempts, start a fresh session with a rewritten brief.
   - Report the honest outcome either way.

   On failure, the error is tagged `delegate failed [reason]: …`. `unknown-model` and
   `agent-error` mean an argument was rejected — fix it, retrying is pointless.
   `hard-cap`, `idle-timeout` and `aborted` carry a `resumeSessionId` — resume it if the
   work should continue (`aborted` means the host interrupted you, so often it shouldn't).
   `agent-exit` means the process died: resume once, then run `doctor` if it repeats.
   `handshake-timeout` never reached a session; run `doctor`.
4. **Report** — summarize what changed and whether acceptance criteria are met.

For field-level API detail, read [reference.md](reference.md) in this skill directory.

## Defaults


| Parameter   | Default        | Notes                                              |
| ----------- | -------------- | -------------------------------------------------- |
| `mode`      | `agent`        | `plan` = plan only; `ask` = read-only Q&A          |
| `model`     | `composer-2.5` | Default model; Composer 2.5 standard tier          |
| `fast`      | `false`        | `true` = higher costs — ONLY when user asks        |
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
- Never guess a `resumeSessionId`. After any resume call, check `resumed` in the
response — if `false`, the run had **zero** prior context, so re-send a full brief.
`protocolWarnings` carries why the load failed, which separates a stale id from a typo.

## Clarifying questions

When Cursor needs a decision it usually asks in its final message and ends the turn
(`finalMessageAvailable: true`, no files changed). Read the question in `result` and
continue by resuming the **same session** with a free-text answer in `spec` — you are not
limited to any options Cursor listed. (On clients that support MCP elicitation a structured
question may instead surface as a prompt; answer it there. When a response includes
`autoAnswered`, check each choice against the brief's decisions and resume with a
correction if any conflicts.)

## Security

Delegation **auto-approves every permission the agent requests, in every mode** — not only
writes, and not only in `agent` mode. `plan` and `ask` are instructions to the agent, not
boundaries the bridge enforces; `modeChanged` is your only signal that one was ignored.
Treat every call like granting write access to `workspace`, and do not point it at `$HOME`
or `/`.

`contextFiles` resolves paths against `workspace` but is **not confined to it** — the write
boundary is that tree, the read boundary is not. Attach only files you intend the agent to
read.

## Other MCP tools

- **`doctor`** — setup diagnostics when the user asks or delegation fails (`agent.found`, version, elicitation; `deep: true` for handshake).
- **`cancel`** — best-effort cancel by `sessionId` (MCP calls are serialized; often delegate
  must finish first). If the agent ignores it and keeps going, call again with `force: true`
  to kill the process after a grace period.
