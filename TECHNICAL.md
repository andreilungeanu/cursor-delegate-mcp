# Technical reference

Details for integrators and contributors. For a quick start, see [README.md](README.md).

## Architecture

MCP host (orchestrator) → MCP `delegate` tool → this bridge → **cursor-agent** over ACP (stdio JSON-RPC).

The bridge auto-approves every permission request and returns named fields (`sessionId`, `filesReportedByEditTools`, optional `plan` and `todos`) instead of scraping stdout.

## `delegate` tool

Parameters, return fields, failure reasons and timeouts:
[skills/delegate/reference.md](skills/delegate/reference.md) — the single source of truth
for the tool contract. Orchestration guidance is in
[skills/delegate/SKILL.md](skills/delegate/SKILL.md).

### Result envelope

Every tool returns its payload as one compact JSON text block and declares no MCP
`outputSchema`. Declaring one obliges the server to send the same object again as
`structuredContent`, and hosts that read both fields put both copies into the model's context.
`cancel`'s status vocabulary is published in its tool description instead.

### Other tools

- **`cancel`** — best-effort cancel of an in-flight delegation.
- **`doctor`** — setup diagnostics (see below).

## `doctor` tool

| Field | Description |
| ----- | ----------- |
| `plugin.version` | Installed plugin version. |
| `client.name` / `client.version` | MCP client identity; `null` when the host sent none. |
| `client.capabilities` | Raw client capabilities. |
| `agent.found` | Whether the launcher could be spawned at all. |
| `agent.command` | Resolved launcher command line, with `ACP_AGENT_COMMAND` / `ACP_AGENT_ARGS` applied. |
| `agent.version` | `--version` output, or `null`. `found: false` means it is not installed; `found: true` with a `null` version means it exists but did not answer — `agent.error` says why. |
| `agent.error` | Present only when `version` is `null` on a launcher that does exist, e.g. the probe timed out. |
| `runtime` | Node version, platform, architecture, cwd, and stdio transport. |
| `env.ACP_LOG_SIZE` | Flight recorder size (default `2000`). |
| `env.CURSOR_DELEGATE_TRANSCRIPT` | Transcript frame count, or `null` when unset. |

Optional `deep: true` runs a bounded ACP handshake (15 s) and adds `agent.handshake`:
`{ ok: false, error }` on failure — not logged in, or a timeout — or `{ ok: true,
protocolVersion, agentCapabilities, models, currentModel, modes }` on success. `models` and
`modes` are the ids this agent offers for a new session; `protocolVersion` and `currentModel`
are `null` when the agent reported none.

Fields relayed verbatim from the agent are typed as unknown in the schema on purpose: doctor is
what you run when the agent is already misbehaving, so a weird `protocolVersion` must read as a
diagnostic, not fail the call.

## ACP behavior (verified)

- **`parameterizedModelPicker`** in `initialize` enables standard-tier `composer-2.5` (`fast: false`). Without it, only the ~6× fast tier is offered.
- Model: `session/set_model` + `session/set_config_option { configId: "fast", value: "false" }`.
- `session/prompt` requires a content-block array `[{ type: "text", text }]`.
- `session/request_permission` → the broadest allow option by `kind` (`allow_always`, else `allow_once`, else the first offered); the selected `optionId` goes back on the wire. `cursor/create_plan` → accepted/rejected by `mode` (`plan`/`ask` reject, `agent` accepts). `cursor/ask_question` is not implemented: cursor-agent never exposes AskQuestion over ACP and asks in prose instead.
- **Cross-process resume** via `session/load`; unknown ids fall back to a fresh session.
- **`filesReportedByEditTools`**: built solely from ACP `diff` content blocks in `tool_call_update`; no git inference.
- **Progress**: deduplicated high-level tool milestones such as reviewing, editing, and verification. Thought and message chunks are never forwarded as progress or folded into `result`.
- **Long runs**: progress notifications reset client idle timeout; child exit fails fast with stderr.
- **`ACP_LOG_SIZE`**: ring buffer of JSON-RPC frames (default `2000`; `0` disables). Bounds what `CURSOR_DELEGATE_TRANSCRIPT` can return.

## Environment variables

| Variable | Description |
| -------- | ----------- |
| `ACP_AGENT_COMMAND` | Override agent launcher command. |
| `ACP_AGENT_ARGS` | Override agent launcher args. |
| `ACP_LOG_SIZE` | Flight recorder frame count (`0` = off). |
| `CURSOR_DELEGATE_TRANSCRIPT` | Frames of raw ACP transcript to append to failure messages; unset = none. Contains prompts, tool inputs/outputs and agent messages — use it only when debugging the bridge itself. |
| `CURSOR_DELEGATE_HANDSHAKE_MS` | Handshake deadline (default 60 s). |
| `CURSOR_DELEGATE_HARD_CAP_MS` | Absolute delegation cap (default 1 h). |
| `CURSOR_DELEGATE_IDLE_MS` | Opt-in mid-turn idle guard; unset or `0` = off. |
| `ACP_E2E` | Set to `1` to run live e2e tests locally. |

## Source layout

| Path | Purpose |
| ---- | ------- |
| `src/server.js` | MCP server (`delegate`, `cancel`, `doctor`). |
| `src/delegate.js` | One delegation lifecycle. |
| `src/acp-client.js` | ACP client. |
| `src/request-router.js` | Permission, question, plan routing. |
| `src/jsonrpc.js` | NDJSON JSON-RPC peer. |
| `src/spawn.js` | `agent acp` launcher resolution. |
| `src/session-supervisor.js` | Handshake/idle/hard-cap timeouts. |
| `src/agent-reported-files.js` | Path normalization for `filesReportedByEditTools`. |
| `src/doctor.js` | Diagnostics. |
| `src/turn-state.js` | Per-turn accumulation and the `reset()` declaration replay applies. |
| `src/model-options.js` | Model config-option resolution (`effort`, `context`). |
| `src/proc.js` | Liveness check and process kill. |
| `src/errors.js` | Reason-tagged errors. |
| `src/acp-enums.js` | ACP constants. |
| `src/version.js` | Version read from `package.json`. |
| `.claude-plugin/hooks.json`, `.claude-plugin/ensure-deps.mjs` | Claude/VS Code SessionStart dependency bootstrap. |
| `skills/` | Shared plugin skill for host orchestration. |
| `commands/` | Slash command definition (legacy alias for delegate skill). |
| `.mcp*.json` | Version-pinned host MCP server registrations. |
| `.claude-plugin/`, `.codex-plugin/`, `plugin.json` | Claude, Codex, and Copilot plugin manifests. |
| `.agents/plugins/`, `.github/plugin/` | Codex and Copilot marketplace catalogs. |

## Local development

```shell
npm ci
npm test
npm run test:pack
claude --plugin-dir .
claude plugin validate .
```

## Publishing (maintainers)

1. Public repo: [andreilungeanu/cursor-delegate-mcp](https://github.com/andreilungeanu/cursor-delegate-mcp)
2. Keep the package, lockfile, all plugin/marketplace manifests, and npm launcher pins synchronized.
3. Run the Codex plugin validator, `claude plugin validate .`, `npm test`, and `npm run test:pack`.
4. Complete the maintainer release gate, kept locally with the release checklist.
5. Tag the release and publish npm before publishing version-pinned plugin catalogs.

Optional discovery: OpenAI and GitHub plugin directories, the Claude community marketplace, MCP directories, and GitHub topics (`mcp`, `cursor`, `codex`, `copilot`, `claude-code`, `agent-client-protocol`).
