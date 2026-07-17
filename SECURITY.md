# Security

## What this plugin does

`cursor-delegate-mcp` spawns **cursor-agent** in your workspace and **auto-approves file
write and permission requests** over ACP (`allow-always`). Delegated tasks can modify,
create, or delete files under the chosen `workspace` directory.

Treat every `delegate` call like handing an engineer write access to that tree.

## Recommendations

- Point `workspace` at the smallest directory that contains the task (not `$HOME` or `/`).
- Review `filesReportedByAgent` and the git diff before committing.
- Use `mode: "plan"` when you only want a plan, not file changes.
- Run verification (tests, lint) after delegation — the delegate skill asks Claude to do
  this, but automated gates in CI are still your backstop.
- Do not commit secrets (`.env`, credentials, tokens). The bridge does not redact them from
  agent context.

## Reporting vulnerabilities

If you find a security issue in this bridge (not in cursor-agent or an MCP host),
please open a [GitHub Security Advisory](https://github.com/andreilungeanu/cursor-delegate-mcp/security/advisories/new)
or email the maintainer listed in `package.json` instead of filing a public issue with
exploit details.
