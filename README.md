# Cursor Delegate MCP

**Use Cursor from inside Claude Code.** Delegate a coding task to Cursor's agent, get structured results back, and let Claude stay in the driver's seat.

![Demo](demo.gif)

An MCP server that connects your AI client to **cursor-agent** over the [Agent Client Protocol](https://cursor.com/docs/cli/acp). You describe the work; the client passes a structured brief and hands it off. Cursor edits your repo, and you review what changed.

Ships as a **Claude Code plugin** (skill, slash command, hooks) and as a standalone **MCP server** for any compatible client.

## What you can do

- **Delegate implementation** — Send a task to Cursor; files are updated in your workspace.
- **Plan before you build** — Run in plan mode, review the plan, then resume the same session to implement.
- **Get structured output** — Session id, which files changed, stop reason, and optional plan payload — not just raw terminal text.
- **Ask questions mid-run** — If Cursor needs a clarification, it comes back through the client's normal prompt.
- **Check setup** — The `doctor` tool tells you if cursor-agent is missing or misconfigured.

> Delegation **auto-approves file writes** in the target workspace.

## Requirements

- [Node.js 22+](https://nodejs.org/)
- [cursor-agent](https://cursor.com/docs/cli/overview) installed and logged in (`cursor-agent login`)

## Claude Code plugin

Best if you use [Claude Code](https://code.claude.com) and want delegation wired in automatically — skill, slash command, and dependency hooks included.

### Install

```shell
/plugin marketplace add andreilungeanu/cursor-delegate-mcp
/plugin install cursor-delegate-mcp@cursor-delegate-mcp
```

First launch installs plugin dependencies automatically.

### Use it

Say what you want in plain language — for example:

> Use Cursor to add input validation to the signup form and a test for it.

Claude loads the **delegate** skill when you mention Cursor or handing off work. You don't need to know tool names or write a spec file.

Optional slash command for an explicit handoff:

```shell
/cursor-delegate-mcp:delegate Add input validation to the signup form and a test for it
```

**Something not working?** Ask Claude to run `doctor`. If `agent.found` is false, install or log in to cursor-agent.

## MCP server

Use the same server in **any** MCP-compatible client via npx — no Claude Code plugin required:

```shell
npx -y cursor-delegate-mcp
```

**cursor-agent** must be installed and logged in (`cursor-agent login`).

Clarifying-question prompts are interactive only on elicitation-capable clients (Claude Code, Cursor, VS Code). On other clients the recommended option is auto-selected and reported in the delegate result's `autoAnswered`.

### Client configuration

#### Antigravity 2.0

`~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "cursor-delegate-mcp": {
      "command": "npx",
      "args": ["-y", "cursor-delegate-mcp"]
    }
  }
}
```

#### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-delegate-mcp": {
      "command": "npx",
      "args": ["-y", "cursor-delegate-mcp"]
    }
  }
}
```

#### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "cursor-delegate-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "cursor-delegate-mcp"]
    }
  }
}
```

#### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.cursor-delegate-mcp]
command = "npx"
args = ["-y", "cursor-delegate-mcp"]
```

#### Kiro

`~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-delegate-mcp": {
      "command": "npx",
      "args": ["-y", "cursor-delegate-mcp"]
    }
  }
}
```

#### Kilo Code

`~/.config/kilo/kilo.jsonc`:

```jsonc
{
  "mcp": {
    "cursor-delegate-mcp": {
      "type": "local",
      "command": ["npx", "-y", "cursor-delegate-mcp"],
      "enabled": true
    }
  }
}
```

Call the **`delegate`** MCP tool with your task. Use **`doctor`** to verify cursor-agent is available.

## Delegation modes

Applies to both the plugin and the MCP server:

- **Agent (default)** — Cursor implements in your workspace; you review the diff afterward.
- **Plan** — Cursor drafts a plan first; review it, then resume and implement.
- **Ask** — Read-only Q&A over the codebase; no file changes.

By default, delegation uses the **Composer 2.5** model (standard tier). Cursor includes a separate **Auto + Composer** usage pool with generous included quota, apart from the API pool other models draw from. For a different model, say so (for example, "use Opus" or "delegate with Codex").

## License

MIT © Andrei Lungeanu
