# CI Ledger plugin

Claude Code and Codex plugin for [CI Ledger](../../README.md). It runs `npx ci-ledger audit` on a repository and walks through the fixes it ranks by minutes saved.

| Skill | Status |
| --- | --- |
| `audit` | Works. Runs the CLI and summarizes the report. |
| `fix` | Stub: not built yet. |
| `watch` | Stub: not built yet. |
| `agents` | Stub: not built yet (the one-time agent report is part of `audit`). |

## Install in Claude Code

```
/plugin marketplace add EvolveAgents/ci-ledger
/plugin install ci-ledger@ci-ledger
```

Then run `/ci-ledger:audit owner/name`.

## MCP server

The CLI also ships an MCP server (`ci-ledger mcp`) over the last audit's outputs. The plugin does not declare it yet: an `.mcp.json` entry that runs `npx ci-ledger mcp` only works once the package is on npm. Until then, add it by hand (see the main README).

## Manifests

- Claude Code: `.claude-plugin/plugin.json`, listed in the repository's `.claude-plugin/marketplace.json`.
- Codex: `.codex-plugin/plugin.json`. Both plugins share `skills/`.

The manifests are hand-written for now. Rendering both from one source moves to the Project Framework CLI later.
