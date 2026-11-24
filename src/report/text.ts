import type { FindingsDoc } from "../findings/index.js";
import type { Finding } from "../findings/types.js";
import { RULES } from "../findings/index.js";
import type { Metrics } from "../metrics/index.js";
import { resolvePath } from "../util/path.js";

const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "" : ` / $${fmt(n, 2)}`);

export function modelLine(m: Metrics): string {
  const x = m.model;
  const est = `${fmt(x.estimatedBillableMinutes)} billable min${x.estimatedUsd !== null ? ` ($${fmt(x.estimatedUsd, 2)})` : ""}`;
  if (x.actualBillableMinutes === null) return `Estimate ${est}; no billing data, so confidence is LOW (${x.confidenceReason}).`;
  return `Estimate ${est} vs billing ${fmt(x.actualBillableMinutes)} min: model error ${x.errorPct === null ? "n/a" : `${x.errorPct > 0 ? "+" : ""}${x.errorPct}%`} (confidence ${x.confidence}).`;
}

/** The `ci-ledger findings` summary: headline numbers, then fixes ranked by minutes saved. */
export function findingsSummary(doc: FindingsDoc, m?: Metrics): string {
  const lines = [`ci-ledger: ${doc.repo}, ${doc.window.since} to ${doc.window.until} (${doc.window.days} days)`];
  if (m) {
    lines.push(modelLine(m));
    lines.push(`${fmt(m.window.runs)} runs, ${fmt(m.window.prsMerged)} PRs merged, ${fmt(m.model.roundingWasteMinutes)} min of rounding waste.`);
  }
  lines.push("", `Fixes ranked by minutes saved per 30 days (sum ${fmt(doc.totals.minutesPer30d)} min${usd(doc.totals.usdPer30d)}; fixes can overlap):`);
  const width = Math.max(...doc.findings.map((f) => f.id.length), 10);
  doc.findings.forEach((f, i) => {
    const saved = f.kind === "report" ? "report" : f.savings.minutesPer30d ? `${fmt(f.savings.minutesPer30d)} min${usd(f.savings.usdPer30d)}` : "time, not minutes";
    lines.push(`${String(i + 1).padStart(3)}. ${f.id.padEnd(width)}  ${saved.padEnd(20)} ${f.confidence.padEnd(6)}  ${f.title}`);
  });
  if (doc.skipped.length) {
    lines.push("", "Skipped:");
    for (const s of doc.skipped) lines.push(`  ${s.ruleId}: ${s.reason}`);
  }
  if (doc.notTriggered.length) {
    lines.push("", "Checked, nothing found:");
    for (const s of doc.notTriggered) lines.push(`  ${s.ruleId}: ${s.reason}`);
  }
  lines.push("", "Run `ci-ledger explain <id>` for evidence and the fix.");
  return lines.join("\n");
}

function table(t: NonNullable<Finding["table"]>): string[] {
  const cells = [t.columns, ...t.rows.map((r) => r.map((c) => (c === null ? "n/a" : String(c))))];
  const widths = t.columns.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  return cells.map((r) => `  ${r.map((c, i) => c.padEnd(widths[i]!)).join("  ")}`.trimEnd());
}

export function explainFinding(f: Finding, m?: Metrics): string {
  const lines = [`${f.id}  (${f.kind}, confidence ${f.confidence})`, f.title, "", f.summary, "", "Evidence (metrics.json path = value):"];
  for (const e of f.evidence) {
    const live = m && !e.metric.startsWith("config.") ? resolvePath(m, e.metric) : undefined;
    const shown = typeof live === "number" || typeof live === "string" ? live : e.value;
    lines.push(`  ${e.label}: ${shown ?? "n/a"}    [${e.metric}]`);
  }
  if (f.table) lines.push("", ...table(f.table));
  lines.push("", `Savings: ${f.savings.minutesPer30d ? `${fmt(f.savings.minutesPer30d, 1)} min per 30 days${usd(f.savings.usdPer30d)}` : "none in billed minutes"}`, `  ${f.savings.basis}`);
  lines.push("", `Fix: ${f.fix.summary}`, ...f.fix.steps.map((s) => `  - ${s}`));
  if (f.fix.yaml) lines.push("", "Sketch:", ...f.fix.yaml.split("\n").map((l) => `  ${l}`));
  return lines.join("\n");
}

/** Explains a finding by id, every finding of a rule, or why a rule produced nothing. */
export function explain(doc: FindingsDoc, id: string, m?: Metrics): string | null {
  const exact = doc.findings.find((f) => f.id === id);
  if (exact) return explainFinding(exact, m);
  const ofRule = doc.findings.filter((f) => f.ruleId === id || f.id.startsWith(`${id}:`));
  if (ofRule.length) return ofRule.map((f) => explainFinding(f, m)).join(`\n\n${"-".repeat(60)}\n\n`);
  const rule = RULES.find((r) => r.id === id);
  const quiet = [...doc.skipped, ...doc.notTriggered].find((s) => s.ruleId === id);
  if (rule) return [`${rule.id}: ${rule.title}`, "", rule.description, "", quiet ? `This run: ${quiet.reason}` : "This run: no findings."].join("\n");
  return null;
}
