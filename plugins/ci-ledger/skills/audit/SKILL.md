---
name: audit
description: Audit a GitHub repository's Actions minutes, merge queue and pull request flow with CI Ledger, then summarize the fixes ranked by minutes saved. Use when asked why CI costs what it does, how to cut Actions minutes, or how the merge queue and PRs are flowing.
argument-hint: "[owner/name] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--org name]"
allowed-tools: Bash(npx:*), Bash(git remote get-url:*), Bash(gh auth status:*), Read
---

# CI Ledger audit

Run the CI Ledger CLI against one repository and explain what it found.

## 1. Pick the repository

Use the `owner/name` the user gave in `$ARGUMENTS`. If none, read `git remote get-url origin` in the current project and take `owner/name` from it. If there is no GitHub remote, ask which repository to audit.

## 2. Check access

CI Ledger reads `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. Do not ask the user to paste a token into the chat. If none is set, tell them to run `gh auth login` or export a token, and name the permissions:

- fine-grained token: Actions (read), Pull requests (read), Contents (read), and Administration (read) for rulesets and branch protection
- billing actuals need an organization owner or billing manager; without them the audit still runs and labels its numbers lower confidence

## 3. Run the audit

```bash
npx --yes ci-ledger audit --repo OWNER/NAME
```

Add any `--since`, `--until` or `--org` flags from `$ARGUMENTS`. The default window is the last 30 days. Large repositories take several minutes; the cache in `.ci-ledger-cache/` lets a rerun resume, and `--from-cache` replays it with no network.

Until `ci-ledger` is published to npm, run it from GitHub instead:

```bash
npx --yes github:EvolveAgents/ci-ledger audit --repo OWNER/NAME
```

To show what the report looks like without a token, run `npx --yes ci-ledger audit --fixture`, which audits a built-in synthetic repository.

## 4. Report back

The command prints the model error and the fixes ranked by minutes saved, and writes `ci-ledger-report/metrics.json`, `findings.json` and `report.html`.

- Lead with the estimated billable minutes, the billing actuals, and the model error. If billing was unavailable, say so and that the numbers are runtime-based estimates.
- List the top fixes with minutes and dollars per 30 days and their confidence. Say that fixes can overlap.
- For any fix the user asks about, run `npx --yes ci-ledger explain <finding-id>` and walk through the evidence and the YAML sketch.
- Point the user to `ci-ledger-report/report.html` for the full report.

CI Ledger works on metadata only. It never downloads or stores CI log text, and everything stays on this machine.
