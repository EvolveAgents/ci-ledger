import type { Config } from "../config.js";
import type { Metrics } from "../metrics/index.js";

export type Confidence = "high" | "medium" | "low";

/** A number shown with a finding, with the metrics.json path it comes from. */
export interface Evidence {
  label: string;
  value: string | number | null;
  metric: string;
}

export interface Savings {
  /** Billable minutes saved per 30 days, scaled from the window. 0 for findings that save time, not minutes. */
  minutesPer30d: number;
  /** Dollars per 30 days at the blended rate; null when the minutes are unpriced. */
  usdPer30d: number | null;
  /** How the number was computed, in a sentence. */
  basis: string;
}

export interface Fix {
  summary: string;
  steps: string[];
  /** A YAML diff sketch, when the fix is a workflow change. */
  yaml?: string;
}

export interface Finding {
  /** Stable id: the rule id, plus a slug of the subject when a rule reports per workflow or check. */
  id: string;
  ruleId: string;
  title: string;
  /** "fix" findings are ranked by minutes saved; "report" findings (forecasts, summaries) follow them. */
  kind: "fix" | "report";
  subject?: string;
  summary: string;
  evidence: Evidence[];
  savings: Savings;
  confidence: Confidence;
  fix: Fix;
  /** Optional table for the report and `explain`. */
  table?: { columns: string[]; rows: Array<Array<string | number | null>> };
}

export type RuleResult =
  | { status: "findings"; findings: Finding[] }
  | { status: "skipped"; reason: string }
  | { status: "not-triggered"; reason: string };

export interface Rule {
  id: string;
  title: string;
  /** What the rule looks for, for `explain` and the README. */
  description: string;
  detect(metrics: Metrics, config: Config): RuleResult;
}
