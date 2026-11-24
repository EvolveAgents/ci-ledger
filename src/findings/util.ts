import type { Metrics } from "../metrics/index.js";
import { round } from "../util/stats.js";
import type { Confidence, Evidence, Savings } from "./types.js";

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

/** Scales window minutes to 30 days. */
export function per30(m: Metrics, windowMinutes: number): number {
  return round((windowMinutes * 30) / Math.max(1, m.window.days), 1);
}

/** Blended $/minute from the estimate (0 on public repos), or null when nothing is priced. */
export function blendedRate(m: Metrics): number | null {
  if (!m.model.privateRepo) return 0;
  const { estimatedUsd, estimatedBillableMinutes } = m.model;
  if (estimatedUsd === null || estimatedBillableMinutes <= 0) return null;
  return estimatedUsd / estimatedBillableMinutes;
}

export function savings(m: Metrics, windowMinutes: number, basis: string): Savings {
  const minutesPer30d = per30(m, Math.max(0, windowMinutes));
  const r = blendedRate(m);
  return { minutesPer30d, usdPer30d: r === null ? null : round(minutesPer30d * r, 2), basis };
}

export const noSavings = (basis: string): Savings => ({ minutesPer30d: 0, usdPer30d: null, basis });

export function ev(label: string, value: string | number | null, metric: string): Evidence {
  return { label, value, metric };
}

/** Lowers confidence one step when the cost model itself is low confidence (no billing data). */
export function withModel(m: Metrics, c: Confidence): Confidence {
  if (m.model.confidence !== "low") return c;
  return c === "high" ? "medium" : "low";
}

export function workflowIndex(m: Metrics, name: string): number {
  return m.workflows.findIndex((w) => w.name === name);
}

export function pct(v: number | null): string {
  return v === null ? "n/a" : `${round(v * 100, 1)}%`;
}
