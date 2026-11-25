# Installing cursor-delegate-mcp

Instructions for an AI agent setting this server up on the user's machine.

## Prerequisites

1. **Node.js 20+** — `node --version`.
2. **Cursor CLI** — `cursor-agent --version`. If missing, install it per <https://cursor.com/docs/cli/overview>.
3. **A logged-in Cursor account** — run `cursor-agent login`. This opens a browser and is interactive: **ask the user to run it themselves**, do not attempt it in a background shell.

The server itself needs no install step; `npx` fetches it on first run.

## Configuration

Add a local stdio server. Many hosts use a top-level `mcpServers` object (Claude Desktop, Cline, Windsurf, Kiro, Antigravity, …):

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

Cline ends a tool call after 60 s; add `"timeout": 3600`, its maximum.

Host-specific files and shapes — including OpenCode and Kilo Code (`mcp` + `type: "local"` + `command` as one array) — are in the README. Do not paste `mcpServers` into those two.

No API keys and no environment variables are required. Auth is Cursor's own CLI session.

## Verify

Call the `doctor` tool. It reports how `cursor-agent` resolves on PATH, whether it is logged in and on which plan, and lists whatever needs action in `warnings`. Call it with `deep: true` to also open an ACP session; a deep `doctor` with empty `warnings` means `delegate` is ready.

## Optional environment variables

| Variable | Purpose |
| --- | --- |
| `CURSOR_DELEGATE_HARD_CAP_MS` | Absolute cap on a single delegation (default 6 h). |
| `CURSOR_DELEGATE_HANDSHAKE_MS` | Handshake deadline (default 60 s). |
| `CURSOR_DELEGATE_TRANSCRIPT` | Frames of raw ACP transcript to append to failure messages; unset = none. |

Defaults are documented in [TECHNICAL.md](TECHNICAL.md); leave them unset unless the user asks.
