import { existsSync, readFileSync } from "node:fs";
import { packagePath } from "./paths.js";
import { addDays, isValidDay, todayUtc } from "./util/time.js";

/**
 * First matching rule wins. A rule matches a workflow when ANY of its criteria match.
 * `name` and `path` are case-insensitive regular expressions; `events` are run events;
 * `triggerTypes` are activity types in the workflow file's pull_request / pull_request_target
 * triggers; `requiredChecks` matches workflows whose jobs report a required status check.
 */
export interface WorkflowGroupRule {
  group: string;
  name?: string;
  path?: string;
  events?: string[];
  triggerTypes?: string[];
  requiredChecks?: boolean;
}

export interface AgentRule {
  agent: string;
  branchPrefixes?: string[];
  authors?: string[];
}

export interface RunnerRate {
  sku: string;
  os: string;
  perMinute: number;
  labels: string[];
}

export interface RateTable {
  currency: string;
  effective?: string;
  source?: string;
  runners: RunnerRate[];
}

export interface Config {
  window: { days: number; since?: string; until?: string };
  workflowGroups: WorkflowGroupRule[];
  agents: AgentRule[];
  /** Logins treated as bot reviewers in addition to any login ending in "[bot]". */
  botReviewers: string[];
  /** Logins counted as human reviewers. null means anyone who is not a bot. */
  humanReviewers: string[] | null;
  sampling: { perStratum: number; minStratumRuns: number; seed: string; maxOutlierRuns: number };
  /** Runs with a wall time at or above this many minutes are treated as outliers. */
  outlierMinutes: number;
  /** Open PRs with no activity for this many days are stale. */
  staleDays: number;
  /** Jobs shorter than this are "short" for the rounding-waste rule. */
  shortJobSeconds: number;
  billing: { includedMinutes: number | null; spendingLimitUsd: number | null };
  rates: RateTable;
}

export const DEFAULT_WORKFLOW_GROUPS: WorkflowGroupRule[] = [
  { group: "dependabot", path: "^dynamic/dependabot/", name: "^dependabot" },
  { group: "code-scanning", path: "^dynamic/github-code-scanning/", name: "codeql|code scanning|scorecard" },
  { group: "required", requiredChecks: true },
  {
    group: "pr-automation",
    events: ["workflow_run", "issue_comment", "pull_request_review", "pull_request_review_comment"],
    triggerTypes: ["labeled", "unlabeled", "edited", "assigned", "review_requested"],
    name: "label|triage|assign|auto-?merge|welcome|stale|pr title|semantic|size|changelog|backport",
  },
];

export const DEFAULT_AGENTS: AgentRule[] = [
  { agent: "codex", branchPrefixes: ["codex/"] },
  { agent: "claude", branchPrefixes: ["claude/"] },
  { agent: "copilot", branchPrefixes: ["copilot/"], authors: ["Copilot"] },
  { agent: "cursor", branchPrefixes: ["cursor/"] },
  { agent: "devin", branchPrefixes: ["devin/"], authors: ["devin-ai-integration[bot]"] },
  { agent: "dependabot", branchPrefixes: ["dependabot/"], authors: ["dependabot[bot]"] },
  { agent: "renovate", branchPrefixes: ["renovate/"], authors: ["renovate[bot]"] },
];

/** Compared without a trailing "[bot]" and case-insensitively; any login ending in "[bot]" is a bot anyway. */
export const DEFAULT_BOT_REVIEWERS = [
  "copilot-pull-request-reviewer",
  "Copilot",
  "coderabbitai",
  "chatgpt-codex-connector",
  "gemini-code-assist",
];

export const NO_AGENT = "none";
export const OTHER_GROUP = "other";

export function loadRates(): RateTable {
  const raw = JSON.parse(readFileSync(packagePath("config", "rates.json"), "utf8")) as RateTable & {
    $comment?: string;
  };
  return { currency: raw.currency, effective: raw.effective, source: raw.source, runners: raw.runners };
}

export function defaultConfig(): Config {
  return {
    window: { days: 30 },
    workflowGroups: DEFAULT_WORKFLOW_GROUPS,
    agents: DEFAULT_AGENTS,
    botReviewers: DEFAULT_BOT_REVIEWERS,
    humanReviewers: null,
    sampling: { perStratum: 12, minStratumRuns: 5, seed: "ci-ledger", maxOutlierRuns: 50 },
    outlierMinutes: 120,
    staleDays: 14,
    shortJobSeconds: 60,
    billing: { includedMinutes: null, spendingLimitUsd: null },
    rates: loadRates(),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merges plain objects; arrays and scalars in `override` replace the base value. */
export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k.startsWith("$")) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k], v) : v;
  }
  return out as T;
}

export const DEFAULT_CONFIG_FILE = "ci-ledger.config.json";

/** Loads defaults, then the config file (explicit path, or ./ci-ledger.config.json when present). */
export function loadConfig(path?: string): Config {
  const file = path ?? (existsSync(DEFAULT_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : undefined);
  const base = defaultConfig();
  if (!file) return base;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isPlainObject(parsed)) throw new Error(`${file}: expected a JSON object`);
  return validateConfig(mergeConfig(base, parsed));
}

export function validateConfig(config: Config): Config {
  const problems: string[] = [];
  for (const rule of config.workflowGroups) {
    for (const key of ["name", "path"] as const) {
      const pattern = rule[key];
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, "i");
      } catch {
        problems.push(`workflowGroups[${rule.group}].${key} is not a valid regular expression`);
      }
    }
  }
  if (!(config.outlierMinutes > 0)) problems.push("outlierMinutes must be > 0");
  if (!(config.sampling.perStratum > 0)) problems.push("sampling.perStratum must be > 0");
  for (const r of config.rates.runners) {
    if (!(r.perMinute >= 0)) problems.push(`rates.runners[${r.sku}].perMinute must be >= 0`);
  }
  if (problems.length) throw new Error(`Invalid config:\n  ${problems.join("\n  ")}`);
  return config;
}

export interface Window {
  since: string;
  until: string;
}

/** CLI flags win over the config file; the default is the last `window.days` days ending today (UTC). */
export function resolveWindow(config: Config, flags: { since?: string; until?: string }, now = new Date()): Window {
  const until = flags.until ?? config.window.until ?? todayUtc(now);
  const since = flags.since ?? config.window.since ?? addDays(until, -(config.window.days - 1));
  for (const [label, v] of [["since", since], ["until", until]] as const) {
    if (!isValidDay(v)) throw new Error(`--${label} must be a date in YYYY-MM-DD form, got "${v}"`);
  }
  if (since > until) throw new Error(`--since (${since}) is after --until (${until})`);
  return { since, until };
}
