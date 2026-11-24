/** Summary of a numeric sample. Percentiles use linear interpolation between closest ranks. */
export interface Distribution {
  n: number;
  mean: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}

/** Linear-interpolation percentile (the "R-7" / numpy default method) over a sorted array. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[sorted.length - 1]!;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function r(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits);
}

export function distribution(values: Iterable<number>, digits = 2): Distribution {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0, mean: null, p50: null, p75: null, p90: null, max: null };
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  return {
    n,
    mean: r(mean, digits),
    p50: r(percentile(sorted, 0.5), digits),
    p75: r(percentile(sorted, 0.75), digits),
    p90: r(percentile(sorted, 0.9), digits),
    max: r(sorted[n - 1]!, digits),
  };
}

export function sum(values: Iterable<number>): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** Ratio rounded to 4 digits, or null when the denominator is zero. */
export function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round(numerator / denominator, 4);
}

export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function countBy<T>(items: Iterable<T>, key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
