import type { Run } from "../types.js";
import { minutesBetween } from "../util/time.js";
import { rngFor, sample } from "../util/rng.js";

/** Lowercased, whitespace-collapsed, digit runs replaced by "#", so "Node 20" and "Node 22" share a stratum. */
export function normalizeWorkflowName(name: string): string {
  return name.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
}

export function stratumKey(run: Pick<Run, "name" | "event">): string {
  return `${normalizeWorkflowName(run.name)}|${run.event}`;
}

/** Wall-clock minutes from start (or creation) to the last update, for completed runs only. */
export function wallMinutes(run: Run): number | null {
  if (run.status !== "completed") return null;
  return minutesBetween(run.runStartedAt ?? run.createdAt, run.updatedAt);
}

export interface SamplePlan {
  /** Every stratum, keyed by stratumKey, with the ids of all its non-outlier completed runs. */
  strata: Map<string, number[]>;
  sampledRunIds: number[];
  outlierRunIds: number[];
}

export interface SampleOptions {
  perStratum: number;
  minStratumRuns: number;
  seed: string;
  outlierMinutes: number;
  maxOutlierRuns: number;
}

/**
 * One stratum per (normalized workflow name, event). Strata with at least `minStratumRuns`
 * completed runs get up to `perStratum` runs sampled with a seeded RNG, so the same window and
 * seed always pick the same runs. Outlier runs (wall time >= outlierMinutes) are kept out of the
 * strata and fetched individually, longest first.
 */
export function planSample(runs: readonly Run[], options: SampleOptions): SamplePlan {
  const strata = new Map<string, number[]>();
  const outliers: Array<{ id: number; minutes: number }> = [];
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    const minutes = wallMinutes(run);
    if (minutes === null) continue;
    if (minutes >= options.outlierMinutes) {
      outliers.push({ id: run.id, minutes });
      continue;
    }
    const key = stratumKey(run);
    const list = strata.get(key);
    if (list) list.push(run.id);
    else strata.set(key, [run.id]);
  }
  const sampledRunIds: number[] = [];
  for (const [key, ids] of [...strata.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.length < options.minStratumRuns) continue;
    sampledRunIds.push(...sample(ids, options.perStratum, rngFor(options.seed, key)));
  }
  outliers.sort((a, b) => b.minutes - a.minutes || a.id - b.id);
  return {
    strata,
    sampledRunIds,
    outlierRunIds: outliers.slice(0, options.maxOutlierRuns).map((o) => o.id),
  };
}
