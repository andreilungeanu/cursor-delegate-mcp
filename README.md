# Cursor ACP Bridge

**Use Cursor from inside Claude Code.** Delegate a coding task to Cursor's agent, get structured results back, and let Claude stay in the driver's seat.

A Claude Code plugin that connects Claude to **cursor-agent** over the [Agent Client Protocol](https://cursor.com/docs/cli/acp). You describe the work; Claude passes a structured brief inline and hands it off. Cursor edits your repo, and Claude reviews what changed.

## What you can do

- **Delegate implementation** — Claude sends a task to Cursor; files are updated in your workspace.
- **Plan before you build** — Run in plan mode, review the plan, then resume the same session to implement.
- **Get structured output** — Session id, which files changed, stop reason, and optional plan payload — not just raw terminal text.
- **Ask questions mid-run** — If Cursor needs a clarification, it comes back through Claude's normal prompt.
- **Check setup** — The `doctor` tool tells you if cursor-agent is missing or misconfigured.

> Delegation **auto-approves file writes** in the target workspace. 

## Requirements

- [Node.js 22+](https://nodejs.org/)
- [cursor-agent](https://cursor.com/docs/cli/overview) installed and logged in (`cursor-agent login`)
- [Claude Code](https://code.claude.com)

## Install

```shell
/plugin marketplace add andreilungeanu/cursor-acp-bridge
/plugin install cursor-acp-bridge@cursor-acp-bridge
```

First launch installs plugin dependencies automatically.

## Use it

Install the plugin, then say what you want in plain language — for example:

> Use Cursor to add input validation to the signup form and a test for it.

Claude loads the **delegate** skill when you mention Cursor or handing off work. You don't need to know tool names or write a spec file.

Optional slash command for an explicit handoff:

```shell
/cursor-acp-bridge:delegate Add input validation to the signup form and a test for it
```

### Modes

Ask Claude to delegate in the mode that fits:

- **Agent (default)** — Cursor implements in your workspace; you review the diff afterward.
- **Plan** — Cursor drafts a plan first; review it, then ask Claude to resume and implement.
- **Ask** — read-only Q&A over the codebase; no file changes.

By default, delegation uses the **Composer 2.5** model (standard tier). Cursor includes a separate **Auto + Composer** usage pool with generous included quota, apart from the API pool other models draw from. For a different model, say so (for example, “use Opus” or “delegate with Codex”).

**Something not working?** Ask Claude to run `doctor`. If `agent.found` is false, install or log in to cursor-agent.

## License

MIT © Andrei Lungeanu
