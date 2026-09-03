# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.0] - 2026-09-03

### Fixed

- `cancel` with `force: true` can be retried after a kill that did not observe an exit. `stop()`
  no longer memoizes that `false`, which had made every later force a no-op.
- Force-kill unregisters only the handles it actually stopped, so a resume that registers during
  teardown stays cancellable instead of running untracked.
- Todo `cancelled` is kept and counted in `todoProgress.cancelled` instead of being stripped.
- `contextFiles` aliases (Win32 case, `realpath`) are sent once.
- `doctor` reports `agent.error` when `--version` exits non-zero, probes `.mjs`/`.cjs` launchers
  with Node, quotes the resolved command, and includes launcher/timeout env knobs.

### Changed

- Permission notes in `TECHNICAL.md` match the router: no allow option → `cancelled`, never the
  first offered reject.

## [2.0.0] - 2026-08-21

One thing changes on upgrade: pass `workspace` on every call, resumes included.

### Changed

- **Breaking: `workspace` is required on every call** — `agent`, `plan`, `ask`, and every
  resume. An omitted `workspace` used to mean the server's own working directory, which under
  `npx` or a plugin install is a cache folder or your home directory, so a defaulted call put
  an auto-approved agent to work on a tree nobody named.
- **Breaking: `result` comes back at full length.** The 10MB cap and its
  `[output truncated at 10MB]` marker are gone. The stream is the model's own message, bounded
  by its output limit; a byte cap here handed back a partial answer as if it were the whole one.
- An `agent-exit` failure carries the whole captured `stderr` rather than its last 2000
  characters. This is the one string that says why the agent died, and the part naming the
  rejected model, the exhausted quota or the expired login can sit anywhere in it. The 64KB
  ring buffer is the bound.
- `CHANGELOG.md` ships in the npm artifact.

### Added

- `-v` is accepted alongside `--version`.
- A `logo` field on the Claude and Agent plugin manifests, pointing at `assets/logo-light.png`.
  With no `.cursor-plugin/` directory in the repository, those are the manifests Cursor reads, and
  `logo` is the field its marketplace tile draws an icon from.

### Fixed

- **The Claude Code plugin installs its dependencies on Windows.** `npm` is a shell script
  there, so the bootstrap spawn could not find it and a fresh plugin install had no working
  delegation at all.
- The bootstrap install runs unless every declared dependency is present. It used to skip on
  finding the first one, leaving a partial `node_modules` in place.
- An error on the readline interface reading the agent is handled. Unhandled, it was an
  uncaught exception that took down the MCP server and every concurrent delegation with it.
- A malformed ACP frame is dropped and reported in `protocolWarnings`. A non-array `content`
  threw inside the readline callback — the whole server, not one turn, and the reply on the
  next line went unread so the turn hung to its cap. A non-array plan `entries` threw in the
  sanitizer after the turn's work was done.
- A permission request that offers no allow option is answered `cancelled`. The router used to
  fall back to the first option offered, returning a reject id under a `selected` outcome,
  which the agent reads as approval of the denial.
- A router bug is reported as `-32603`. It used to send `-32000`, which ACP assigns to
  `auth_required`, sending the agent down a recovery path that cannot work.
- The host going away — `SIGINT`, `SIGTERM`, or stdin closing — kills in-flight delegations and
  gives them time to land before the server exits. A delegation still inside its handshake is
  reached too: the agent process exists about 3.4s before its session id does.
- The signal handler records the exit code as it runs and schedules the exit off the kill's
  settlement stack, so a loop that runs dry on its own still dies with the code the signal
  asked for.
- On Windows the kill runs only while the child is alive. `taskkill /T` walks parent links an
  exited leader no longer has, and a reaped pid can already belong to somebody else.
- Only a parsed ACP frame counts as agent activity. A launcher writing to stderr used to hold
  the idle guard open and made "Last ACP frame Ns ago" report a stderr byte.
- The version probe drains the agent's stderr, so a launcher noisy enough to fill the pipe
  reports its version instead of reading out as a timeout.
- A resumed session moves back to the recent end of the session history, so `cancel` no longer
  answers `not-found` for a live, resumable session that aged out on insertion order.
- A multi-line tool title is reported as one line. A terminal tool's title is the command the
  agent sent, and a multi-line script arrives with its newlines.
- A non-numeric `CURSOR_DELEGATE_TRANSCRIPT` reads as on at 50 frames rather than off.
  `Number("true")` is `NaN`, so the most natural way to ask for a transcript disabled the one
  thing it was asking for — in the recorder and again where the frames are appended.
- A stale non-terminal update for a finished tool call is ignored. It used to restart result
  collection, so the turn's final message came back as `discardedResult` under
  `resultSource: "pre-tool-fallback"` — a clean answer labelled an unreliable preamble.

### Documentation

- The delegate reference records that `effectiveModel` reports no model for `default` (Auto).
- The Codex plugin manifest and the host-compatibility issue template drop their remaining
  read-only claims.

### Internal

- The release workflow is gated on the full test workflow rather than one `npm test` leg.
- Coverage for the `allow_once` fallback, the doctor option list, the peer error frame, the
  bare-`{}` ack methods, and the stderr ring-buffer trim driven through a real spawn.

## [1.22.0] - 2026-08-13

### Added

- **`cursor-delegate-mcp --version` prints the version and exits.** The flag previously fell
  through to the stdio transport, which owns stdout and waits on stdin, so an install could only
  be confirmed after it was wired into a host. The version is read from the `package.json` beside
  the running code, so it reports what is executing rather than what a manifest pinned.

### Removed

- **Breaking: `spec` is sent as written. A `spec` that is a file path is no longer read as the
  brief.** The bridge guessed which of the two a caller meant by sniffing the string for path
  shape, so the meaning depended on whether a matching file existed. Orchestrators write the
  brief and attach files with `contextFiles`, leaving nothing to disambiguate. A caller passing a
  bare path now gets that path as the prompt text, with no error. `invalid-spec` fires only on a
  blank `spec`.

### Fixed

- **The documented `cancel` vocabulary matches what 1.21.0 shipped.** The skill reference said a
  forced cancel reports `killed`; since 1.21.0 that requires an observed exit, and a force that
  cannot confirm one reports `cancelled` and keeps the session cancellable. It also called
  `not-found` an id never seen by this process, which stops holding past the 500-session history
  cap.

### Changed

- **The handshake skips config round-trips that would set what is already set.**
  `session/set_model` goes only when the session did not open on the requested model, and
  `session/set_config_option { configId: "fast" }` only when the session did not open on that
  model *at* that tier — Cursor persists both, and persists the tier per model, so the values
  `session/new` and `session/load` report are what the turn would otherwise re-assert. Anything
  that reads the reply still sends it: an `effort` to validate, or `model: "default"`, whose
  served id is only visible there. A value the agent does not report reads as a mismatch and
  sends, and any model change re-applies the tier rather than trusting the previous model's. Two
  delegations on the same model and tier now spend ~3.4 s in setup instead of ~5.5 s; a first
  call, or one that switches model or tier, is unchanged.
- **The ACP flight recorder records only when a transcript is asked for.** Every frame in and out
  was retained whenever `ACP_LOG_SIZE` was above 0, which is the default, while the only consumer
  is `CURSOR_DELEGATE_TRANSCRIPT` — unset by default. `ACP_LOG_SIZE` still bounds retention and
  still disables at `0`.
- **Three skill and reference facts now match the code.** `doctor deep` documents
  `currentModelOptions`, including that it describes `currentModel` only — any other model needs a
  `set_model` the handshake does not send. The skill's discovery description no longer calls `ask`
  read-only. `TECHNICAL.md` lists the routing the request router performs.

## [1.21.0] - 2026-08-13

### Fixed

- **Teardown reaches the agent's descendants on POSIX.** `treeKill` sent `SIGKILL` to a single
  pid, so commands the agent spawned outlived cancel-with-force, a host abort, a handshake
  timeout and doctor's version probe; `taskkill /T` already took the tree on Windows. The agent
  now leads its own process group and the group is killed. Because that also removes the agent
  from this process's group, `SIGINT` and `SIGTERM` sweep registered delegations explicitly
  rather than relying on the terminal to reach the child.

### Changed

- **Explicit effort is validated against the selected model's live options before the prompt.**
  Invalid values name the accepted set, models without configurable effort tell callers to omit
  the field, and unavailable capability data fails as `effort-options-unavailable`. Calls that
  omit `effort` are unchanged.
- **`cancel` reports `killed` only when the agent process was observed to exit.** `treeKill`
  resolves whether or not the kill landed, so the status was untruthful. A forced cancel that
  cannot confirm an exit answers `cancelled` and keeps the session registered, so force can be
  retried rather than answering `not-found`.

## [1.20.0] - 2026-08-13

### Fixed

- **An async rejection no longer exits the server.** The progress callback wrapped
  `sendNotification` in `try`/`catch`, but the SDK declares it `async`: the returned promise was
  never awaited, so a transport rejection settled outside the `catch` and reached the process,
  which under Node's default `--unhandled-rejections=throw` took every concurrent delegation down
  with it. Two more instances of the same shape are closed: the ACP request router's discarded
  promise, and `stdout`, which had no `error` listener where `stdin` and `stderr` both did.
- **A host abort during spec resolution is no longer lost.** The pre-flight check ran before the
  spec was read and the abort listener was registered after it, and `addEventListener` does not
  replay an abort that already fired — so an abort landing in that window was dropped and the turn
  ran to completion against an aborted signal.
- **A failed resume no longer silently starts a fresh session.** Every `session/load` error fell
  back, so a transient failure ran the whole task without the context the caller asked for and
  reported it as a warning on a successful result. Only a session the agent does not have falls
  back now.
- **Every failure that leaves a live session names the id to resume.** The session id is assigned
  at `session/new`, before the model and config calls, so an unknown model or a rejected config
  value abandoned a resumable session without naming it. The hint was previously reserved for
  stalls, aborts and exits.

### Added

- **`resume-failed`** — a resume that fails for any reason other than the agent not having that
  session. Nothing is started, so the caller can retry or omit `resumeSessionId` deliberately.
- **`invalid-spec` and `invalid-workspace` are documented.** Both were already raised; neither
  appeared in the failure table the skill points at for every reason.

### Changed

- **`handshake-timeout` no longer tells hosts there is nothing to resume.** Setup continues past
  `session/new`, so the session often exists; the error already named it while the skill said to
  abandon it.
- **`doctor` verification points at the call that proves login.** The install guide credited the
  shallow probe, which only resolves `cursor-agent` on PATH — login shows up in the `deep: true`
  handshake.
- **`plan` and `ask` read as instructed behavior in the skill's parameter table**, matching what
  the same file already says about modes not being enforced.

### Removed

- **The `reasoning` input is gone from the schema.** 1.19.0 kept it declared solely to reject it,
  so every caller read a field it must never use. Callers read the live schema and pass `effort`,
  so the stale-caller it guarded against is hypothetical. A `reasoning` key is now dropped by
  schema validation without comment.

## [1.19.0] - 2026-08-12

### Changed

- **`reasoning` is now `effort`.** Config option ids differ per model — gpt-5.x declares
  `reasoning`, grok and gemini declare `effort`, Claude declares `thinking` and `effort` together,
  `composer-2.5` declares none — so one hardcoded id could not reach them all, and `reasoning`
  silently did nothing on three families. `effort` resolves against the ids the agent reports for
  the model in use, read from the `configOptions` the `fast` reply already carries; models that
  refuse `fast` — `claude-haiku-4-5`, `claude-sonnet-5`, `gemini-3.6-flash` — report the list on a
  re-assert of the model just set. A model whose only thought-level option is boolean
  (`claude-haiku-4-5` declares just `thinking`) is never sent a level, since that is a guaranteed
  invalid value and would fail the run. Passing
  `reasoning` is rejected before the agent is spawned, naming `effort`; it is not accepted as an
  alias, because an undeclared argument would be stripped and the requested effort lost silently.
- **The ignored-effort warning no longer misstates the model's capability.** It said "model X has
  no reasoning option" — false for every model that declares effort under a different id. It now
  names the ids the model does declare.

### Added

- **`doctor` with `deep: true` reports `currentModelOptions`** — option ids and allowed values for
  the model the session opened with. `session/new` already returned these; other models would each
  need a `set_model` first and are not reported.

## [1.18.1] - 2026-08-09

### Changed

- **`workspace` guidance now has a floor.** "Smallest directory that fits" had no lower bound, so
  callers invented throwaway directories for runs touching no files. The skill and the parameter
  description now name the floor — smallest directory holding the task's files, never one created
  for the call — and state that scoping bounds writes, not reads.

## [1.18.0] - 2026-08-07

Findable, and answerable. The server can now be published to the official MCP Registry — the
metadata source the VS Code gallery and most aggregators read from — and the repository finally
carries the contribution and issue surfaces GitHub expects. No runtime behaviour changes.

### Added

- **`server.json`** declaring the registry record, and **`mcpName`** in `package.json`. The
  registry verifies ownership by matching the two, so both are covered by `version-sync.test.js`
  along with the version they each pin.
- **Registry publishing from the release workflow.** A `registry` job runs after `publish`,
  because ownership is verified against the package that must already be on npm.
- **`CONTRIBUTING.md` and issue templates** at the repository root: installation problems, host
  compatibility reports, and successful delegation reports. The project ships no telemetry, so
  those reports are the only signal that a real run worked somewhere else.

### Changed

- **The npm description leads with the outcome** rather than the protocol, and the keyword list
  covers Composer, delegation, and coding-agent terms.

## [1.17.0] - 2026-08-07

Every answer, once. 1.16.0 stopped `delegate` and `doctor` sending their payload twice; this
release clears the three places a response still said the same thing twice. Nothing the
orchestrator has to read is lost — only the second copy.

### Changed

- **`cancel` returns one compact JSON text block**, `{"status":…,"sessionId":…}`, and declares
  no `outputSchema` — matching `delegate` and `doctor`. The prose text block is gone and the
  status vocabulary lives in the tool description. Callers reading `structuredContent` must read
  `content[0].text` and parse it.
- **`plan` is no longer returned in `plan`/`ask` mode**, where `result` is already the agent's
  own plan message and the plan itself lives in the agent's session — which is what a
  resume-to-implement reads. Agent mode is unchanged: there the implementation report and the
  plan are separate artifacts and both stay.
- **Skipped `contextFiles` collapse into one warning** naming the workspace root once instead of
  repeating it per file. Twenty missing attachments: 1,961 bytes of warnings down to ~455.

## [1.16.0] - 2026-08-07

`delegate` and `doctor` now answer once instead of twice. The fields they report are unchanged.

### Changed

- **`delegate` and `doctor` no longer return `structuredContent`.** The result is a single
  compact JSON text block. Both previously sent the same payload twice — pretty-printed text
  *and* `structuredContent` — which a host reading both (Codex does) loaded into the model's
  context twice. Hosts that read the text block are unaffected; a host wired to
  `structuredContent` for these two tools must read `content[0].text` and parse it. `cancel`
  still returns `structuredContent`.
- `TECHNICAL.md` is tracked at the repo root and its stale contract corrected;
  `skills/delegate/reference.md` is the single source of truth for `delegate` and `doctor`
  fields.

### Security

- Lockfile-only dependency bump clearing the high-severity audit advisories.

### Internal

- Test suite: the ACP client stub is declared once instead of in 19 hand-rolled copies, and
  tests left behind by deleted heuristics are collapsed or removed. Two regression tests
  covering `delegate` behaviour moved out of `session-supervisor.test.js` and are named for
  what they assert rather than for a retired bug label.
- Code comments state the constraint that still holds rather than the change history behind it.
  Every protocol fact, agent quirk and probe measurement is retained; `git log` keeps the rest.

## [1.15.0] - 2026-08-07

### Changed

- The plugin is renamed `cursor-delegate-mcp` → `cursor-delegate`, so the selector reads
  `cursor-delegate@cursor-delegate-mcp` instead of repeating itself. Claude Code v2.1.193+
  migrates existing installs through the marketplace's new `renames` map; elsewhere,
  reinstall once. Update permission rules to `mcp__plugin_cursor-delegate_cursor-delegate__*`.

Marketplace, MCP server key and npm package names are unchanged, as are standalone installs.

## [1.14.0] - 2026-07-25

A correctness, performance and tooling pass. `delegate`'s contract is unchanged. `doctor` gains
`agent.error` and now advertises `agent.command`, `agent.version` and the deep `handshake`, which
previously reached hosts undeclared.

### Fixed

- `doctor` no longer hangs forever on a launcher that accepts `--version` and never answers.
  The probe is time-boxed (10s) and reports `agent.error` instead — the deep handshake was
  already guarded; the shallow probe that runs on every call was not.
- `cancel` no longer reports a running turn as already ended. Two delegations can share a
  session id (a resume racing the turn it resumes), and whichever finished first used to
  deregister the other.
- A non-positive or malformed `CURSOR_DELEGATE_HARD_CAP_MS` / `CURSOR_DELEGATE_HANDSHAKE_MS`
  falls back to its default instead of arming a zero-length deadline that failed every call
  instantly. `0` still disables the idle guard, the one knob where it is documented to.
- A malformed `ACP_LOG_SIZE` keeps the 2000-frame default rather than silently disabling the
  transcript. Explicit `0` still disables it.
- A permission request carrying no options is answered `cancelled` rather than with a
  selection that names no option.
- ACP frames arriving after the prompt settles no longer fold into a result that is still
  being assembled.
- A JSON-RPC reply whose `id` echoes back as a string now resolves its request instead of
  leaving it pending until a timeout.
- Agent stderr is decoded incrementally, so a multi-byte character split across pipe reads no
  longer reaches the error message as a replacement character.
- Writes to the agent's stdin after the process is gone can no longer surface as an unhandled
  error event.

### Performance

- The ACP frame log is trimmed in batches instead of shifting a 2000-entry array on every
  frame: 100k inbound frames went from 588ms to 84ms, against a 71ms no-logging floor.
- Agent stderr is accumulated in chunks rather than rebuilding a 64KB string per write.
- The spec and context files are read asynchronously, so a large brief or an inline image no
  longer blocks concurrent delegations and their progress notifications.

### Internal

- Turn state moved into `src/turn-state.js` behind a single `reset()`, replacing a
  hand-maintained block that cleared thirteen variables before each prompt — a field added
  without a matching line there leaked the previous turn's data into a resumed result.
- Every tagged failure is raised through one shared `makeError`.
- Plan and todo enums have a single source (`src/acp-enums.js`) instead of four hand-synced
  copies across the sanitizers and the zod schemas.
- The advertised output schemas are exported as shapes so tests parse every `delegate` and
  `doctor` result against a `.strict()` copy: the production schemas are passthrough, so a
  field added to a result but not to its schema would otherwise never reach hosts and no test
  would fail. `doctor` had drifted that way — it declared only `agent.found`, leaving
  `command`, `version`, `error` and the deep `handshake` undeclared.
- Type checking with `tsc --checkJs`, plus CI gates for types, a coverage floor and
  `npm audit`. The lockfile moved to clear a high-severity `fast-uri` advisory.

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
