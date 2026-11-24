# CI Ledger

Version 0.1.0 · 2026-11-24

CI Ledger explains a GitHub organization's Actions bill, merge queue and pull request flow, including the coding agents working in the repo. It turns what it finds into fixes ranked by the minutes and dollars they save. It is a Node CLI with a Claude Code and Codex plugin on top.

It reads metadata only: run, job and step names and times, PR events, workflow files and billing usage. It never downloads CI logs, and everything stays on your machine.

v1 covers GitHub Actions on github.com. GitHub-hosted runner minutes are priced; self-hosted minutes are counted but not priced. GitHub Enterprise Server is not supported.

## Install

Requires Node 22 or later. The package is not on npm yet, so run it from GitHub or from a clone:

```bash
npx --yes github:EvolveAgents/ci-ledger audit --repo owner/name
```

```bash
git clone https://github.com/EvolveAgents/ci-ledger && cd ci-ledger && npm ci && npm run build
```

From a clone, run `node dist/src/bin.js <command>`, or `npm link` to get a `ci-ledger` command.

## Quick start

See a full report without a token or network. `--fixture` audits a built-in, entirely synthetic repository:

```bash
ci-ledger audit --fixture
```

Audit a real repository over the last 30 days:

```bash
ci-ledger audit --repo owner/name
```

Then:

```bash
ci-ledger findings
```

```bash
ci-ledger explain rounding-waste
```

Open `ci-ledger-report/report.html` in a browser. It is one self-contained file that works offline, in light and dark mode.

## Commands

| Command | What it does |
| --- | --- |
| `ci-ledger audit --repo owner/name` | Collects data and writes `metrics.json`, `findings.json` and `report.html`. |
| `ci-ledger findings` | Prints the ranked findings from the last audit. `--json` prints them as JSON. |
| `ci-ledger explain <id>` | Shows a finding's evidence (with `metrics.json` paths), the savings basis, the fix and a YAML sketch. A rule id lists its findings or says why it found nothing. |

`audit` options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--repo owner/name` | required | Repository to audit. |
| `--org name` | repo owner | Organization whose billing to read. |
| `--since`, `--until` | last 30 days to today (UTC) | Window, as `YYYY-MM-DD`. |
| `--out dir` | `ci-ledger-report` | Output directory. |
| `--cache-dir dir` | `.ci-ledger-cache` | On-disk cache. A rerun resumes from it. |
| `--from-cache` | off | Read only from the cache; no network. |
| `--fixture` | off | Audit the built-in synthetic repository. |
| `--config file` | `./ci-ledger.config.json` if present | Config file. |
| `--no-billing` | off | Skip the billing API. |
| `--rest` | off | Use REST instead of GraphQL for PR timelines. |

## Token and permissions

CI Ledger reads `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. Without a token it can read public repositories at 60 requests an hour, which is too few for most audits.

| Input | API | Fine-grained token permission |
| --- | --- | --- |
| Workflow runs and sampled jobs | `GET /repos/{o}/{r}/actions/runs`, `.../runs/{id}/jobs` | Actions: read |
| PRs, timelines, reviews, commits, changed files | GraphQL, or REST `pulls/{n}`, `issues/{n}/timeline`, `pulls/{n}/commits`, `pulls/{n}/reviews`, `pulls/{n}/files` | Pull requests: read. If the REST timeline returns 403, add Issues: read. |
| Workflow files and behind-base counts | `contents/.github/workflows`, `compare/{base}...{head}` | Contents: read |
| Required checks and merge queue | `rules/branches/{branch}`, falling back to `branches/{branch}/protection` | Administration: read |
| Billing usage | `GET /organizations/{org}/settings/billing/usage` | Organization Administration: read, on a token of an org owner or billing manager |

Classic tokens need the `repo` scope for private repositories.

Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1`. Node's built-in `fetch` ignores `HTTPS_PROXY` without it, and `audit` prints a hint when it sees the proxy variable alone.

Billing is optional. Without it (a 403 or 404, or `--no-billing`), the audit falls back to its runtime-based estimate and labels it lower confidence in `metrics.json`, `findings.json` and on page one of the report.

Some tokens and proxies block GraphQL. CI Ledger then switches to the REST timeline and says so in the notes. The REST timeline may not include merge-queue removal reasons, so conflict hotspots work best with GraphQL.

## Data handling

- **Metadata only.** CI Ledger never calls the logs endpoints and never stores log text. It keeps run, job and step names, times and conclusions, runner labels, PR states and timeline events (including commit headlines and logins), workflow file contents, and billing usage items. It does not keep PR titles or bodies.
- **Local only.** Data goes from the GitHub API to `.ci-ledger-cache/` and `ci-ledger-report/` on your machine and nowhere else. Delete those directories to remove it.
- **Review before sharing.** The outputs name workflows, files, PR numbers and agents. Check them before you post a report outside your organization.

## How the cost model works

1. GitHub bills each job rounded up to a whole minute, so a job's billable minutes are `ceil(duration)`. A run's billable minutes are the sum over its jobs, and rounding waste is billed minutes minus real minutes.
2. Runs are grouped into strata, one per (normalized workflow name, event). Each stratum with at least 5 runs gets up to 12 runs sampled with a seeded RNG, so a rerun picks the same runs. Its estimate is the mean sampled billable minutes per run × its run count. Runs from smaller strata are reported separately and left out of the estimate.
3. Runs with a wall time of 120 minutes or more are outliers. Their jobs are fetched and added exactly.
4. When billing usage is available, the estimate is compared with the actual minutes for that repository and window, and the error in % is on page one.
5. Prices come from [`config/rates.json`](config/rates.json), not from code. It ships with Linux 2-core at $0.006 a minute (GitHub's list price since 2026-01-01). Add rows for the other runner types you use, or they are counted as unpriced. Public repositories use standard runners for free.

Known limits: jobs come from `filter=latest`, so earlier attempts of re-run workflows are not in the estimate. Required-check failure rates come from sampled jobs.

## Findings catalog (v1)

Each rule gives a savings estimate in minutes per 30 days (and dollars when priced), a confidence level, a fix and, where it fits, a YAML diff sketch. Fixes are ranked by minutes saved. Fixes that touch the same runs overlap, so their sum is an upper bound.

| Rule | Looks for | Fix |
| --- | --- | --- |
| `rounding-waste` | Many jobs under 60 s, each billed a whole minute | Fold short jobs into a parent job as steps |
| `helper-fanout` | Workflows triggered by `labeled`, `edited` or `workflow_run` re-running on unchanged code | Narrow event types, merge helpers, add `if:` guards |
| `duplicate-suites` | The same test command in two PR workflows | Run it once |
| `fails-by-design` | A non-required workflow failing fast most of the time | Exit 0 and report the state in the job summary |
| `queue-ejections` | Failed merge groups, by check and reason | Run that check before the PR enters the queue |
| `conflict-hotspots` | Files most often behind conflict ejections | Generate or split the file |
| `revision-churn` | Pushes per PR rising with PR size and review rounds | Enforce a size ceiling |
| `lead-time-split` | Where PR lead time goes | Aim at the slowest stage |
| `stale-prs` | Open PRs behind base with no recent activity | Close or rebase |
| `cap-forecast` | Month-to-date minutes against included minutes and the spending limit | The projected cap date, and time to act |
| `missing-cancellation` | PR workflows without a concurrency group that cancels older runs | Add `concurrency` with `cancel-in-progress` |
| `agent-report` | CI minutes caused by each agent's pushes, PRs opened and merged, rework rounds | A one-time report |

`queue-ejections` and `conflict-hotspots` need a merge queue, which exists only on public repositories and on private repositories under GitHub Enterprise Cloud. Without one, both are skipped and the output says why.

## Outputs

- `metrics.json` (schema `ci-ledger/metrics`, versioned). Every number in the report traces to it. Distributions are `{n, mean, p50, p75, p90, max}` with linear-interpolation percentiles.
- `findings.json` (schema `ci-ledger/findings`, versioned). Each finding's evidence lists the `metrics.json` path of every number it shows.
- `report.html`. A self-contained report with the model error and the ranked fixes on page one.

## Configuration

Put a `ci-ledger.config.json` in the working directory, or pass `--config`. Objects merge with the defaults, and arrays replace them. Example:

```json
{
  "window": { "days": 30 },
  "agents": [
    { "agent": "codex", "branchPrefixes": ["codex/"] },
    { "agent": "claude", "branchPrefixes": ["claude/"] },
    { "agent": "copilot", "branchPrefixes": ["copilot/"], "authors": ["Copilot"] },
    { "agent": "dependabot", "branchPrefixes": ["dependabot/"], "authors": ["dependabot[bot]"] }
  ],
  "botReviewers": ["copilot-pull-request-reviewer", "coderabbitai"],
  "humanReviewers": null,
  "workflowGroups": [
    { "group": "dependabot", "path": "^dynamic/dependabot/" },
    { "group": "code-scanning", "path": "^dynamic/github-code-scanning/", "name": "codeql" },
    { "group": "required", "requiredChecks": true },
    { "group": "pr-automation", "events": ["workflow_run"], "triggerTypes": ["labeled", "edited"] }
  ],
  "outlierMinutes": 120,
  "staleDays": 14,
  "sampling": { "perStratum": 12, "minStratumRuns": 5, "seed": "ci-ledger" },
  "billing": { "includedMinutes": 3000, "spendingLimitUsd": 0 },
  "rates": {
    "currency": "USD",
    "runners": [{ "sku": "linux-2-core", "os": "linux", "perMinute": 0.006, "labels": ["ubuntu-latest", "ubuntu-24.04"] }]
  }
}
```

- `agents`: an agent is matched by head-branch prefix first, then by PR author. PRs that match no rule are `none`.
- `botReviewers`: compared without a trailing `[bot]`. Any login ending in `[bot]` is a bot anyway. `humanReviewers: null` means everyone else.
- `workflowGroups`: the first matching rule wins, and a rule matches when any of its criteria match. Workflows that match none are `other`.
- `billing.includedMinutes` and `spendingLimitUsd` feed `cap-forecast`. The billing API does not report them.

## Plugins

`plugins/ci-ledger` is one plugin for both Claude Code (`.claude-plugin/plugin.json`) and Codex (`.codex-plugin/plugin.json`). The two share `skills/`. The `audit` skill runs the CLI and walks through the results; `fix`, `watch` and `agents` are stubs for now.

In Claude Code:

```
/plugin marketplace add EvolveAgents/ci-ledger
/plugin install ci-ledger@ci-ledger
```

Then run `/ci-ledger:audit owner/name`.

The manifests are hand-written for now. Rendering them moves to the Project Framework CLI later.

## Development

```bash
npm ci
```

```bash
npm test
```

`npm test` compiles with `tsc` and runs the `node:test` suites. All test data is synthetic: `src/fixtures/synthetic.ts` builds a seeded repository, and `src/fixtures/fake-github.ts` serves it through the same REST and GraphQL endpoints the collector calls.

| Path | Contents |
| --- | --- |
| `src/collect` | GitHub client use, per-day and per-run cache, sampling, PR timelines, billing, setup |
| `src/model` | Cost model, strata, run-to-PR linking, classification |
| `src/metrics` | `metrics.json` sections |
| `src/findings` | The rule catalog, one module per rule |
| `src/report` | Text summaries and `report.html` |
| `plugins/ci-ledger` | Claude Code and Codex plugin |

## License

Apache-2.0
