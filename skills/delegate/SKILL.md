---
name: delegate
description: >
  Ask Cursor for its view or hand it coding work through the cursor-delegate-mcp delegate
  tool. Use when the user says ask Cursor, Composer or Grok what it thinks, get a second
  opinion from Cursor, delegate or hand off to Cursor or Composer, plan with Cursor, resume a
  Cursor session, or diagnose Cursor delegation. Do not shell out to cursor-agent.
license: MIT
---

# Delegate to Cursor

Call the cursor-delegate-mcp `delegate` tool; never run `cursor-agent` from the shell.

## Write the brief

`spec` carries the whole task, inline:

- **Goal**: the outcome, precisely.
- **Scope**: the files and directories in play. Point at files to read or follow rather than
  pasting code; attach images and documents outside the repo with `contextFiles`.
- **Decisions**: what the user already settled, in their exact words.
- **Done when**: verifiable acceptance criteria, and the tests to run while it works. For `ask` and
  `plan`, the form and length of the answer.
- End by asking Cursor to report any criterion it could not meet and any assumption it made.

`workspace` is the smallest existing directory that holds the task's files.

## Ask and compare

`mode: "ask"` answers a question or gives a second opinion; `result` is the answer. To compare
models, send the same brief in parallel calls, one `model` per call or another plugin's
`delegate` tool, then set the answers side by side with your own view. Check the claims that
matter before relaying them.

## Hand off the work

- `agent` implements.
- `plan`: `result` is the plan. Present it, wait for approval, then resume the session in
  `agent` mode with `resumeSessionId` and a `spec` such as "implement the approved plan" plus
  any changes.

Parallel runs that write need separate directories; otherwise run them one after another.

## After the run

1. Read the git diff after every run, whatever the mode, and run the tests yourself when files
   changed. `filesReportedByEditTools` misses files written by shell commands.
2. `todoProgress` with `completed < total` means unfinished work, and `todos` lists it: resume
   rather than report done. Its absence means nothing.
3. `effectiveModel` means a different model served the turn. `effectiveEffort` is the level in
   force; report it rather than calling it the default.
4. If a criterion fails on a sound approach, resume the same session with the specific
   failure. For a wrong approach, or after two failed resumes, start a new session with a
   rewritten brief. After a resume, an absent
   `resumed` means that run had no prior context: send the full brief on the returned
   `sessionId`.
5. Report what changed and which criteria pass.

A failure arrives as `delegate failed [reason]: …`. Fix `invalid-spec`, `invalid-workspace` and
`unknown-model` rather than retrying; every other reason, and any unfamiliar field, is explained
in [reference.md](reference.md).
