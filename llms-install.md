# Installing cursor-delegate-mcp

Instructions for an AI agent (Cline, Claude Code, …) setting this server up on the user's machine.

## Prerequisites

1. **Node.js 20+** — `node --version`.
2. **Cursor CLI** — `cursor-agent --version`. If missing, install it per <https://cursor.com/docs/cli/overview>.
3. **A logged-in Cursor account** — run `cursor-agent login`. This opens a browser and is interactive: **ask the user to run it themselves**, do not attempt it in a background shell.

The server itself needs no install step; `npx` fetches it on first run.

## Configuration

Add to the MCP settings file (`cline_mcp_settings.json` for Cline):

```json
{
  "mcpServers": {
    "cursor-delegate": {
      "command": "npx",
      "args": ["-y", "cursor-delegate-mcp"]
    }
  }
}
```

No API keys and no environment variables are required. Auth is Cursor's own CLI session.

## Verify

Call the `doctor` tool. It reports the Node version, whether `cursor-agent` is on PATH, and whether the CLI session is authenticated, naming whatever is missing. A clean `doctor` means `delegate` is ready.

## Optional environment variables

| Variable | Purpose |
| --- | --- |
| `CURSOR_DELEGATE_IDLE_MS` | Mid-turn idle guard; unset or `0` = off. |
| `CURSOR_DELEGATE_HARD_CAP_MS` | Absolute cap on a single delegation (default 1 h). |
| `CURSOR_DELEGATE_HANDSHAKE_MS` | Handshake deadline (default 60 s). |
| `CURSOR_DELEGATE_TRANSCRIPT` | Frames of raw ACP transcript to append to failure messages; unset = none. |

Defaults are documented in [TECHNICAL.md](TECHNICAL.md); leave them unset unless the user asks.
