import type { Config, RateTable } from "../config.js";
import type { Billing, Dataset, Job, Run } from "../types.js";
import { round, sum } from "../util/stats.js";
import { minutesBetween } from "../util/time.js";
import { planSample, wallMinutes } from "./strata.js";

export const SELF_HOSTED = "self-hosted";
export const UNPRICED = "unpriced";

/** A job's real minutes, and billable minutes rounded up to a whole minute as GitHub bills them. */
export function jobMinutes(job: Job): { real: number; billable: number } {
  const real = minutesBetween(job.startedAt, job.completedAt) ?? 0;
  return { real, billable: real > 0 ? Math.ceil(real - 1e-9) : 0 };
}

/** The rate-table SKU for a job's runner, SELF_HOSTED, or UNPRICED for hosted labels missing from the table. */
export function skuFor(job: Job, rates: RateTable): string {
  const labels = job.labels.map((l) => l.toLowerCase());
  if (labels.includes("self-hosted")) return SELF_HOSTED;
  const rate = rates.runners.find((r) => r.labels.some((l) => labels.includes(l.toLowerCase())));
  return rate?.sku ?? UNPRICED;
}

export interface RunCost {
  billable: number;
  real: number;
  /** Billed minutes minus real minutes on GitHub-hosted runners. */
  roundingWaste: number;
  /** Billable minutes by SKU, self-hosted included (counted, never priced). */
  bySku: Record<string, number>;
}

export function runCost(jobs: readonly Job[], rates: RateTable): RunCost {
  const bySku: Record<string, number> = {};
  let billable = 0;
  let real = 0;
  for (const job of jobs) {
    const m = jobMinutes(job);
    const sku = skuFor(job, rates);
    bySku[sku] = (bySku[sku] ?? 0) + m.billable;
    if (sku === SELF_HOSTED) continue;
    billable += m.billable;
    real += m.real;
  }
  return { billable, real, roundingWaste: billable - real, bySku };
}

/** USD for minutes by SKU; self-hosted and unpriced SKUs cost nothing here. Public repos use free standard runners. */
export function priceOf(bySku: Record<string, number>, rates: RateTable, isPrivate: boolean): number {
  if (!isPrivate) return 0;
  return sum(Object.entries(bySku).map(([sku, minutes]) => minutes * (rates.runners.find((r) => r.sku === sku)?.perMinute ?? 0)));
}

export interface StratumRow {
  stratum: string;
  workflow: string;
  event: string;
  runs: number;
  sampled: number;
  meanBillable: number;
  meanReal: number;
  estimatedBillable: number;
  estimatedRoundingWaste: number;
  bySku: Record<string, number>;
}

export interface Estimate {
  strata: StratumRow[];
  unsampled: { strata: number; runs: number; wallMinutes: number; rows: Array<{ stratum: string; runs: number; wallMinutes: number }> };
  outliers: { thresholdMinutes: number; runs: Array<{ id: number; workflow: string; event: string; wallMinutes: number; billable: number | null }> };
  totals: {
    billableMinutes: number;
    roundingWasteMinutes: number;
    selfHostedMinutes: number;
    unpricedMinutes: number;
    bySku: Record<string, number>;
    usd: number | null;
  };
}

/**
 * Per stratum: mean sampled billable minutes per run x the stratum's run count. Outliers are added
 * exactly from their own jobs. Strata too small to sample are reported separately, not estimated.
 */
export function estimateBillable(data: Dataset, config: Config): Estimate {
  const plan = planSample(data.runs, { ...config.sampling, outlierMinutes: config.outlierMinutes });
  const byId = new Map(data.runs.map((r) => [r.id, r]));
  const rows: StratumRow[] = [];
  const unsampledRows: Estimate["unsampled"]["rows"] = [];
  const bySku: Record<string, number> = {};
  const addSku = (src: Record<string, number>, k: number) => {
    for (const [s, m] of Object.entries(src)) bySku[s] = (bySku[s] ?? 0) + m * k;
  };
  for (const [stratum, ids] of [...plan.strata.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const costs = ids.filter((id) => data.jobs[String(id)]).map((id) => runCost(data.jobs[String(id)]!, config.rates));
    const first = byId.get(ids[0]!)!;
    if (ids.length < config.sampling.minStratumRuns || costs.length === 0) {
      unsampledRows.push({ stratum, runs: ids.length, wallMinutes: round(sum(ids.map((id) => wallMinutes(byId.get(id)!) ?? 0)), 1) });
      continue;
    }
    const n = costs.length;
    const meanBillable = sum(costs.map((c) => c.billable)) / n;
    const meanReal = sum(costs.map((c) => c.real)) / n;
    const meanSku: Record<string, number> = {};
    for (const c of costs) for (const [s, m] of Object.entries(c.bySku)) meanSku[s] = (meanSku[s] ?? 0) + m / n;
    addSku(meanSku, ids.length);
    rows.push({
      stratum,
      workflow: first.name,
      event: first.event,
      runs: ids.length,
      sampled: n,
      meanBillable: round(meanBillable, 2),
      meanReal: round(meanReal, 2),
      estimatedBillable: round(meanBillable * ids.length, 1),
      estimatedRoundingWaste: round((meanBillable - meanReal) * ids.length, 1),
      bySku: Object.fromEntries(Object.entries(meanSku).map(([s, m]) => [s, round(m * ids.length, 1)])),
    });
  }
  const outlierRuns: Estimate["outliers"]["runs"] = [];
  let outlierBillable = 0;
  let outlierWaste = 0;
  for (const run of data.runs) {
    const wall = wallMinutes(run);
    if (wall === null || wall < config.outlierMinutes) continue;
    const jobs = data.jobs[String(run.id)];
    const cost = jobs ? runCost(jobs, config.rates) : null;
    if (cost) {
      outlierBillable += cost.billable;
      outlierWaste += cost.roundingWaste;
      addSku(cost.bySku, 1);
    }
    outlierRuns.push({ id: run.id, workflow: run.name, event: run.event, wallMinutes: round(wall, 1), billable: cost?.billable ?? null });
  }
  const priced = Object.fromEntries(Object.entries(bySku).map(([s, m]) => [s, round(m, 1)]));
  const billableMinutes = round(sum(rows.map((r) => r.estimatedBillable)) + outlierBillable, 1);
  return {
    strata: rows,
    unsampled: {
      strata: unsampledRows.length,
      runs: sum(unsampledRows.map((r) => r.runs)),
      wallMinutes: round(sum(unsampledRows.map((r) => r.wallMinutes)), 1),
      rows: unsampledRows,
    },
    outliers: { thresholdMinutes: config.outlierMinutes, runs: outlierRuns.sort((a, b) => b.wallMinutes - a.wallMinutes) },
    totals: {
      billableMinutes,
      roundingWasteMinutes: round(sum(rows.map((r) => r.estimatedRoundingWaste)) + outlierWaste, 1),
      selfHostedMinutes: priced[SELF_HOSTED] ?? 0,
      unpricedMinutes: priced[UNPRICED] ?? 0,
      bySku: priced,
      usd: config.rates.runners.length ? round(priceOf(bySku, config.rates, data.repo.private), 2) : null,
    },
  };
}

export interface BillingComparison {
  available: boolean;
  reason?: string;
  actualMinutes: number | null;
  actualGrossUsd: number | null;
  actualNetUsd: number | null;
  estimatedMinutes: number;
  /** (estimate - actual) / actual x 100. */
  errorPct: number | null;
  confidence: "high" | "medium" | "low";
}

export function repoMatches(repositoryName: string, run: { fullName: string; name: string }): boolean {
  const r = repositoryName.toLowerCase();
  return r === run.fullName.toLowerCase() || r === run.name.toLowerCase();
}

/** Compares the estimate with billing actuals for this repo and window. Without billing, confidence is low. */
export function compareWithBilling(estimate: Estimate, billing: Billing, data: Pick<Dataset, "repo" | "window">): BillingComparison {
  const estimatedMinutes = estimate.totals.billableMinutes;
  if (billing.status !== "ok") {
    return { available: false, reason: billing.reason, actualMinutes: null, actualGrossUsd: null, actualNetUsd: null, estimatedMinutes, errorPct: null, confidence: "low" };
  }
  const items = billing.items.filter(
    (i) => repoMatches(i.repositoryName, data.repo) && i.date >= data.window.since && i.date <= data.window.until && /minute/i.test(i.unitType),
  );
  const actual = sum(items.map((i) => i.quantity));
  const errorPct = actual > 0 ? round(((estimatedMinutes - actual) / actual) * 100, 1) : null;
  return {
    available: true,
    actualMinutes: round(actual, 1),
    actualGrossUsd: round(sum(items.map((i) => i.grossAmount)), 2),
    actualNetUsd: round(sum(items.map((i) => i.netAmount)), 2),
    estimatedMinutes,
    errorPct,
    confidence: errorPct !== null && Math.abs(errorPct) <= 10 ? "high" : "medium",
  };
}

export function runsById(runs: readonly Run[]): Map<number, Run> {
  return new Map(runs.map((r) => [r.id, r]));
}
