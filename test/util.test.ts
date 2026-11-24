import { test } from "node:test";
import assert from "node:assert/strict";
import { distribution, percentile, rate } from "../src/util/stats.js";
import { hashString, rngFor, sample } from "../src/util/rng.js";
import { addDays, daysBetween, minutesBetween, weekKey } from "../src/util/time.js";

test("percentile interpolates linearly between closest ranks", () => {
  const xs = [1, 2, 3, 4];
  assert.equal(percentile(xs, 0.5), 2.5);
  assert.equal(percentile(xs, 0.75), 3.25);
  assert.equal(percentile(xs, 0.9), 3.7);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([], 0.5), null);
});

test("distribution reports n, mean, p50, p75, p90 and max", () => {
  assert.deepEqual(distribution([10, 0, 5, 5]), { n: 4, mean: 5, p50: 5, p75: 6.25, p90: 8.5, max: 10 });
  assert.deepEqual(distribution([]), { n: 0, mean: null, p50: null, p75: null, p90: null, max: null });
  assert.equal(distribution([1, Number.NaN, 3]).n, 2);
});

test("rate is null for an empty denominator", () => {
  assert.equal(rate(1, 0), null);
  assert.equal(rate(1, 3), 0.3333);
});

test("seeded sampling is reproducible and without replacement", () => {
  const items = Array.from({ length: 40 }, (_, i) => i);
  const a = sample(items, 12, rngFor("seed", "stratum"));
  const b = sample(items, 12, rngFor("seed", "stratum"));
  const c = sample(items, 12, rngFor("seed", "other"));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a).size, 12);
  assert.deepEqual(sample([1, 2], 12, rngFor("x")).sort(), [1, 2]);
  assert.equal(hashString("abc"), hashString("abc"));
});

test("date helpers work in UTC", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.deepEqual(daysBetween("2026-01-30", "2026-02-01"), ["2026-01-30", "2026-01-31", "2026-02-01"]);
  assert.equal(minutesBetween("2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z"), 1.5);
  assert.equal(minutesBetween("2026-01-01T00:02:00Z", "2026-01-01T00:01:00Z"), null);
  assert.equal(weekKey("2026-01-01T12:00:00Z"), "2026-W01");
  assert.equal(weekKey("2027-01-01T12:00:00Z"), "2026-W53");
});
