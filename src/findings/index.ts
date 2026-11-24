import type { Config } from "../config.js";
import type { Metrics } from "../metrics/index.js";
import { toolVersion } from "../paths.js";
import { agentReport } from "./rules/agent-report.js";
import { capForecast } from "./rules/cap-forecast.js";
import { conflictHotspots } from "./rules/conflict-hotspots.js";
import { duplicateSuites } from "./rules/duplicate-suites.js";
import { failsByDesign } from "./rules/fails-by-design.js";
import { helperFanout } from "./rules/helper-fanout.js";
import { leadTimeSplit } from "./rules/lead-time-split.js";
import { missingCancellation } from "./rules/missing-cancellation.js";
import { queueEjections } from "./rules/queue-ejections.js";
import { revisionChurn } from "./rules/revision-churn.js";
import { roundingWaste } from "./rules/rounding-waste.js";
import { stalePrs } from "./rules/stale-prs.js";
import type { Finding, Rule } from "./types.js";

export const FINDINGS_SCHEMA_VERSION = "1.0.0";

/** The v1 catalog, in catalog order. */
export const RULES: Rule[] = [
  roundingWaste,
  helperFanout,
  duplicateSuites,
  failsByDesign,
  queueEjections,
  conflictHotspots,
  revisionChurn,
  leadTimeSplit,
  stalePrs,
  capForecast,
  missingCancellation,
  agentReport,
];

/** Fixes first, by minutes saved per 30 days (then dollars, then id); reports after them. */
export function rank(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (a.kind === "fix" ? 0 : 1) - (b.kind === "fix" ? 0 : 1) ||
      b.savings.minutesPer30d - a.savings.minutesPer30d ||
      (b.savings.usdPer30d ?? 0) - (a.savings.usdPer30d ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

export function runFindings(metrics: Metrics, config: Config, now = new Date()) {
  const findings: Finding[] = [];
  const skipped: Array<{ ruleId: string; title: string; reason: string }> = [];
  const notTriggered: Array<{ ruleId: string; title: string; reason: string }> = [];
  for (const rule of RULES) {
    let result;
    try {
      result = rule.detect(metrics, config);
    } catch (err) {
      result = { status: "skipped" as const, reason: `rule failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (result.status === "findings") findings.push(...result.findings);
    else if (result.status === "skipped") skipped.push({ ruleId: rule.id, title: rule.title, reason: result.reason });
    else notTriggered.push({ ruleId: rule.id, title: rule.title, reason: result.reason });
  }
  const ranked = rank(findings);
  return {
    schema: "ci-ledger/findings" as const,
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    metricsSchemaVersion: metrics.schemaVersion,
    generatedAt: now.toISOString(),
    tool: { name: "ci-ledger", version: toolVersion() },
    repo: metrics.repo.fullName,
    window: { since: metrics.window.since, until: metrics.window.until, days: metrics.window.days },
    modelConfidence: metrics.model.confidence,
    /** Plain sums of the fixes; fixes touching the same runs overlap, so treat these as an upper bound. */
    totals: {
      fixes: ranked.filter((f) => f.kind === "fix").length,
      minutesPer30d: Math.round(ranked.reduce((s, f) => s + f.savings.minutesPer30d, 0) * 10) / 10,
      usdPer30d: ranked.some((f) => f.savings.usdPer30d !== null) ? Math.round(ranked.reduce((s, f) => s + (f.savings.usdPer30d ?? 0), 0) * 100) / 100 : null,
    },
    findings: ranked,
    skipped,
    notTriggered,
  };
}

export type FindingsDoc = ReturnType<typeof runFindings>;
export type { Finding, Rule } from "./types.js";
