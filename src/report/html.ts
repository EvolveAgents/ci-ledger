import type { FindingsDoc } from "../findings/index.js";
import type { Finding } from "../findings/types.js";
import type { Metrics } from "../metrics/index.js";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
const money = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `$${num(n, 2)}`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${num(n * 100, 1)}%`);
/** A number with the metrics.json (or findings.json) path it comes from, shown on hover. */
const m$ = (text: string, path: string) =>
  `<span class="v" title="${path.startsWith("findings.") ? "findings.json" : "metrics.json"}: ${esc(path.replace(/^findings\./, ""))}">${esc(text)}</span>`;

function table(head: string[], rows: Array<Array<string>>, caption?: string): string {
  if (!rows.length) return `<p class="muted">None.</p>`;
  return `<div class="scroll"><table>${caption ? `<caption>${esc(caption)}</caption>` : ""}<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function bars(points: Array<{ label: string; value: number }>, path: string): string {
  if (!points.length) return "";
  const max = Math.max(...points.map((p) => p.value), 1);
  const w = 36;
  const h = 120;
  const body = points
    .map((p, i) => {
      const bh = Math.round((p.value / max) * (h - 24));
      return `<g><title>${esc(p.label)}: ${num(p.value)} min</title><rect x="${i * (w + 8)}" y="${h - 18 - bh}" width="${w}" height="${bh}" rx="3" class="bar"/><text x="${i * (w + 8) + w / 2}" y="${h - 4}" text-anchor="middle" class="axis">${esc(p.label.slice(-3))}</text></g>`;
    })
    .join("");
  return `<svg role="img" aria-label="Estimated billable minutes per week (${esc(path)})" viewBox="0 0 ${points.length * (w + 8)} ${h}" width="${points.length * (w + 8)}" height="${h}">${body}</svg>`;
}

function findingCard(f: Finding, i: number): string {
  const ev = f.evidence.map((e) => [esc(e.label), m$(e.value === null ? "n/a" : typeof e.value === "number" ? num(e.value, 2) : String(e.value), e.metric), `<code>${esc(e.metric)}</code>`]);
  return `<article class="finding" id="${esc(f.id)}">
<h3><span class="rank">${i + 1}</span> ${esc(f.title)} <span class="badge ${f.confidence}">${f.confidence}</span></h3>
<p class="muted"><code>${esc(f.id)}</code> · ${f.kind === "report" ? "report" : f.savings.minutesPer30d ? `${num(f.savings.minutesPer30d)} min / 30 days${f.savings.usdPer30d !== null ? ` · ${money(f.savings.usdPer30d)}` : ""}` : "saves time, not billed minutes"}</p>
<p>${esc(f.summary)}</p>
${table(["Evidence", "Value", "metrics.json path"], ev)}
${f.table ? table(f.table.columns, f.table.rows.map((r) => r.map((c) => esc(c ?? "n/a")))) : ""}
<p class="muted"><strong>Savings basis.</strong> ${esc(f.savings.basis)}</p>
<h4>Fix</h4><p>${esc(f.fix.summary)}</p><ul>${f.fix.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
${f.fix.yaml ? `<pre class="diff">${f.fix.yaml.split("\n").map((l) => `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}">${esc(l)}</span>`).join("\n")}</pre>` : ""}
</article>`;
}

const CSS = `:root{--bg:#fff;--fg:#1b1f24;--muted:#59636e;--card:#f6f8fa;--line:#d1d9e0;--accent:#0969da;--add:#1a7f37;--del:#cf222e;--warn:#9a6700;--warnbg:#fff8c5;--bar:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--card:#151b23;--line:#3d444d;--accent:#4493f8;--add:#3fb950;--del:#f85149;--warn:#d29922;--warnbg:#2b2111;--bar:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{margin-top:40px;border-bottom:1px solid var(--line);padding-bottom:6px}
.muted{color:var(--muted)}code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.card .k{color:var(--muted);font-size:13px}.card .n{font-size:24px;font-weight:600}
.banner{background:var(--warnbg);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;margin:12px 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}caption{text-align:left;color:var(--muted);padding:4px 0}
td.r,th.r{text-align:right}.v{border-bottom:1px dotted var(--muted)}a{color:var(--accent)}
.badge{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:1px 8px;vertical-align:middle;color:var(--muted)}.badge.high{color:var(--add);border-color:var(--add)}.badge.low{color:var(--warn);border-color:var(--warn)}
.finding{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px 16px 12px;margin:16px 0}.rank{display:inline-block;min-width:26px;color:var(--muted)}
pre.diff{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto}.add{color:var(--add)}.del{color:var(--del)}
.bar{fill:var(--bar)}.axis{fill:var(--muted);font-size:10px}
@media print{.page1{page-break-after:always}.finding{break-inside:avoid}}`;

export function renderReport(m: Metrics, f: FindingsDoc): string {
  const x = m.model;
  const fixes = f.findings.filter((d) => d.kind === "fix");
  const lowConfidence = x.confidence === "low";
  const cards = [
    ["Estimated billable minutes", m$(num(x.estimatedBillableMinutes), "model.estimatedBillableMinutes"), x.estimatedUsd !== null ? m$(money(x.estimatedUsd), "model.estimatedUsd") : ""],
    ["Billing actual (minutes)", x.actualBillableMinutes === null ? "unavailable" : m$(num(x.actualBillableMinutes), "model.actualBillableMinutes"), x.actualGrossUsd !== null ? `${m$(money(x.actualGrossUsd), "model.actualGrossUsd")} gross` : ""],
    ["Model error", x.errorPct === null ? "n/a" : m$(`${x.errorPct > 0 ? "+" : ""}${x.errorPct}%`, "model.errorPct"), `confidence <span class="badge ${x.confidence}">${x.confidence}</span>`],
    ["Rounding waste (minutes)", m$(num(x.roundingWasteMinutes), "model.roundingWasteMinutes"), "billed minus real"],
    ["Runs", m$(num(m.window.runs), "window.runs"), `${m$(num(m.window.prsMerged), "window.prsMerged")} PRs merged`],
    ["Savings from fixes (30 days)", m$(num(f.totals.minutesPer30d), "findings.totals.minutesPer30d"), f.totals.usdPer30d !== null ? `${money(f.totals.usdPer30d)} · fixes can overlap` : "fixes can overlap"],
  ];
  const q = m.mergeQueue;
  const lt = m.leadTime;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>CI Ledger: ${esc(m.repo.fullName)}</title><style>${CSS}</style></head>
<body><main>
<section class="page1">
<h1>CI Ledger: ${esc(m.repo.fullName)}</h1>
<p class="muted">${esc(m.window.since)} to ${esc(m.window.until)} (${m.window.days} days) · generated ${esc(m.generatedAt.slice(0, 16).replace("T", " "))} UTC · ci-ledger ${esc(m.tool.version)} · metrics schema ${esc(m.schemaVersion)}</p>
${lowConfidence ? `<div class="banner"><strong>Lower confidence.</strong> ${esc(x.confidenceReason)}. Minutes and dollars below are runtime-based estimates from sampled jobs, not billing actuals.</div>` : ""}
<div class="grid">${cards.map(([k, n, s]) => `<div class="card"><div class="k">${k}</div><div class="n">${n}</div><div class="muted">${s}</div></div>`).join("")}</div>
<p class="muted">${esc(x.confidenceReason.charAt(0).toUpperCase() + x.confidenceReason.slice(1))}. ${x.privateRepo ? `Priced at ${x.rates.map((r) => `${esc(r.sku)} $${r.perMinute}/min`).join(", ")}` : "Public repository: standard GitHub-hosted runners are free"}; self-hosted minutes (${m$(num(x.selfHostedMinutes), "model.selfHostedMinutes")}) are counted, not priced.</p>
<h2>Fixes ranked by minutes saved</h2>
${table(["#", "Fix", "Min / 30 days", "$ / 30 days", "Confidence"], fixes.map((d, i) => [String(i + 1), `<a href="#${esc(d.id)}">${esc(d.title)}</a>`, d.savings.minutesPer30d ? num(d.savings.minutesPer30d) : "time only", d.savings.minutesPer30d ? money(d.savings.usdPer30d) : "", `<span class="badge ${d.confidence}">${d.confidence}</span>`]))}
</section>
<h2>Findings</h2>
${f.findings.map(findingCard).join("\n")}
${f.skipped.length || f.notTriggered.length ? `<h3>Rules skipped or with nothing to report</h3>${table(["Rule", "Status", "Reason"], [...f.skipped.map((s) => [esc(s.ruleId), "skipped", esc(s.reason)]), ...f.notTriggered.map((s) => [esc(s.ruleId), "nothing found", esc(s.reason)])])}` : ""}
<h2>Workflows</h2>
${table(["Workflow", "Group", "Runs", "Wall min", "Billable min (est.)", "Failed", "Cancelled", "Reruns", "p50 min", "p90 min", "Events"], m.workflows.map((w) => [esc(w.name), esc(w.group), num(w.runs), num(w.wallMinutes), num(w.estimatedBillable), num(w.failed), num(w.cancelled), num(w.reruns), num(w.p50, 1), num(w.p90, 1), esc(Object.entries(w.events).map(([e, n]) => `${e} ${n}`).join(", "))]), "metrics.json: workflows")}
<h3>Estimated billable minutes per week</h3>
${bars(m.rollups.weekly.map((r) => ({ label: r.period, value: r.estimatedBillable })), "rollups.weekly[].estimatedBillable")}
<h2>Cost model</h2>
<p>Each job bills its duration rounded up to a whole minute. Each stratum (normalized workflow name × event) is estimated as its mean sampled billable minutes per run × its run count; outlier runs (${m$(num(m.billable.outliers.thresholdMinutes), "billable.outliers.thresholdMinutes")}+ min wall time) are added exactly.</p>
${table(["Workflow", "Event", "Runs", "Sampled", "Mean billable", "Mean real", "Estimate"], m.billable.strata.map((s) => [esc(s.workflow), esc(s.event), num(s.runs), num(s.sampled), num(s.meanBillable, 2), num(s.meanReal, 2), num(s.estimatedBillable)]), "metrics.json: billable.strata")}
<p class="muted">Unsampled strata (fewer than ${m.config.sampling.minStratumRuns} runs): ${m$(num(m.billable.unsampled.strata), "billable.unsampled.strata")} strata, ${m$(num(m.billable.unsampled.runs), "billable.unsampled.runs")} runs, ${m$(num(m.billable.unsampled.wallMinutes), "billable.unsampled.wallMinutes")} wall minutes, not in the estimate. Job queue wait p50 ${m$(num(m.billable.jobQueueWaitSeconds.p50), "billable.jobQueueWaitSeconds.p50")} s, p90 ${m$(num(m.billable.jobQueueWaitSeconds.p90), "billable.jobQueueWaitSeconds.p90")} s.</p>
${table(["Outlier run", "Workflow", "Event", "Wall min", "Billable min"], m.billable.outliers.runs.map((o) => [String(o.id), esc(o.workflow), esc(o.event), num(o.wallMinutes), num(o.billable)]), "metrics.json: billable.outliers.runs")}
${table(["Slowest steps", "Job", "n", "p50 s", "p90 s"], m.billable.slowestSteps.slice(0, 10).map((s) => [esc(`${s.workflow}: ${s.step}`), esc(s.job), num(s.n), num(s.p50), num(s.p90)]), "metrics.json: billable.slowestSteps")}
${m.billing.available ? table(["Month", "Minutes", "Gross", "Net"], m.billing.byMonth.map((b) => [esc(b.month), num(b.minutes), money(b.grossUsd), money(b.netUsd)]), "metrics.json: billing.byMonth") : `<p class="muted">Billing: ${esc(m.billing.reason)}</p>`}
<h2>Merge queue and PR flow</h2>
${q.enabled
  ? `<p>${m$(num(q.entries), "mergeQueue.entries")} queue entries, kick-out rate ${m$(pct(q.kickOutRate), "mergeQueue.kickOutRate")}, ${m$(pct(q.mergedFirstTryRate), "mergeQueue.mergedFirstTryRate")} of merged PRs merged on the first try. Median time in queue: ${m$(num(q.minutesInQueue.merged.p50), "mergeQueue.minutesInQueue.merged.p50")} min (merged), ${m$(num(q.minutesInQueue.ejected.p50), "mergeQueue.minutesInQueue.ejected.p50")} min (ejected). ${m$(num(m.mergeGroups.failed), "mergeGroups.failed")} of ${m$(num(m.mergeGroups.groups), "mergeGroups.groups")} merge groups failed.</p>`
  : `<p class="muted">${esc(q.skippedReason)}</p>`}
${table(["Lead time (hours)", "n", "p50", "p75", "p90"], ([["Created to merged", lt.createdToMerged], ["Created to first queue entry", lt.createdToFirstQueue], ["First queue entry to merged", lt.firstQueueToMerged], ["Last human approval to merged", lt.lastHumanApprovalToMerged]] as const).map(([k, d]) => [k, num(d.n), num(d.p50, 1), num(d.p75, 1), num(d.p90, 1)]), "metrics.json: leadTime")}
${table(["PR size (lines)", "Merged PRs", "Heads pushed", "Force pushes", "Catch-up merges", "Changes requested"], Object.entries(m.revisions.bySize).map(([k, r]) => [esc(k), num(r.prs), num(r.headsPushed.mean, 2), num(r.forcePushes.mean, 2), num(r.catchUpMerges.mean, 2), num(r.changesRequested.mean, 2)]), "metrics.json: revisions.bySize (means)")}
<h2>Data and method</h2>
<ul>
<li>Sources: billing ${esc(m.sources.billing)}, PR timelines via ${esc(m.sources.prTimelines)}, required checks from ${esc(m.sources.requiredChecks)}; ${m$(num(m.sources.sampledRuns), "sources.sampledRuns")} runs sampled for jobs.</li>
<li>Runs link to PRs by run.pull_requests, head branch within the PR's open window, merge-queue branch, or a "PR #n" run name; ${m$(num(m.ciPerPr.linkedRuns), "ciPerPr.linkedRuns")} linked, ${m$(num(m.ciPerPr.ambiguousRuns), "ciPerPr.ambiguousRuns")} ambiguous, ${m$(num(m.ciPerPr.unlinkedRuns), "ciPerPr.unlinkedRuns")} unlinked.</li>
<li>CI Ledger reads metadata only (run, job and step names and times, PR events). It never downloads or stores logs. This file was built offline from metrics.json and findings.json.</li>
${m.sources.notes.map((n) => `<li class="muted">${esc(n)}</li>`).join("")}
</ul>
</main></body></html>
`;
}
