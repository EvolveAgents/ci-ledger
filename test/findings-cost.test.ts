import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { buildMetrics } from "../src/metrics/index.js";
import { RULES, rank, runFindings } from "../src/findings/index.js";
import type { Finding } from "../src/findings/types.js";
import { syntheticDataset } from "./helpers/dataset.js";

const now = new Date("2026-10-31T01:00:00Z");
async function doc(config = defaultConfig(), fake = {}) {
  const m = buildMetrics(await syntheticDataset(fake), config, now);
  return { m, d: runFindings(m, config, now) };
}

/** Resolves a metrics.json path such as "workflows[2].sameHeadRetriggers.runs". */
function resolve(obj: unknown, path: string): unknown {
  return path.split(/\.|\[(\d+)\]/).filter(Boolean).reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
}

test("every rule has a unique id, a title and a description", () => {
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
  for (const r of RULES) assert.ok(r.title && r.description.length > 40, r.id);
});

test("the synthetic repo triggers each cost rule on the workflow built to trigger it", async () => {
  const { d } = await doc({ ...defaultConfig(), billing: { includedMinutes: 3000, spendingLimitUsd: 0 } });
  const ids = d.findings.map((f) => f.id);
  for (const id of [
    "rounding-waste:ci",
    "helper-fanout:pr-labeler",
    "helper-fanout:release-status",
    "duplicate-suites:e2e:npm-test",
    "fails-by-design:release-status",
    "missing-cancellation:ci",
    "cap-forecast",
  ]) assert.ok(ids.includes(id), `${id} in ${ids.join(", ")}`);
  assert.ok(!ids.includes("missing-cancellation:e2e"), "E2E already cancels superseded runs");
  assert.ok(!ids.some((id) => id.startsWith("fails-by-design:ci")), "required gates are not flagged");
});

test("every evidence path resolves in metrics.json to the value shown", async () => {
  const { m, d } = await doc({ ...defaultConfig(), billing: { includedMinutes: 3000, spendingLimitUsd: 0 } });
  for (const f of d.findings) {
    for (const e of f.evidence) {
      if (e.metric.startsWith("config.")) continue;
      const v = resolve(m, e.metric);
      assert.notEqual(v, undefined, `${f.id}: ${e.metric}`);
      if (typeof e.value === "number" && typeof v === "number") assert.equal(v, e.value, `${f.id}: ${e.metric}`);
    }
    assert.ok(f.fix.summary && f.fix.steps.length, f.id);
    assert.ok(f.savings.minutesPer30d >= 0 && f.savings.basis, f.id);
  }
});

test("findings are ranked by minutes saved, reports last", async () => {
  const { d } = await doc({ ...defaultConfig(), billing: { includedMinutes: 3000, spendingLimitUsd: 0 } });
  const fixes = d.findings.filter((f) => f.kind === "fix");
  for (let i = 1; i < fixes.length; i++) assert.ok(fixes[i - 1]!.savings.minutesPer30d >= fixes[i]!.savings.minutesPer30d);
  assert.equal(d.findings[d.findings.length - 1]!.kind, "report");
  const a = { id: "a", kind: "report", savings: { minutesPer30d: 999 } } as Finding;
  const b = { id: "b", kind: "fix", savings: { minutesPer30d: 1 } } as Finding;
  assert.deepEqual(rank([a, b]).map((f) => f.id), ["b", "a"]);
  assert.ok(d.totals.usdPer30d! > 0);
});

test("cap forecast needs included minutes and says so when unset", async () => {
  const { d } = await doc();
  const cap = d.notTriggered.find((n) => n.ruleId === "cap-forecast");
  assert.match(cap?.reason ?? "", /includedMinutes/);
  const forecast = (await doc({ ...defaultConfig(), billing: { includedMinutes: 3000, spendingLimitUsd: 10 } })).d.findings.find((f) => f.id === "cap-forecast")!;
  assert.match(forecast.title, /spending limit reached around 2026-10-/);
});

test("without billing, findings drop a confidence level and say the forecast is repo-only", async () => {
  const { d } = await doc({ ...defaultConfig(), billing: { includedMinutes: 3000, spendingLimitUsd: null } }, { billing: false });
  assert.equal(d.modelConfidence, "low");
  assert.ok(d.findings.every((f) => f.confidence !== "high"));
  const cap = d.findings.find((f) => f.id === "cap-forecast");
  assert.match(cap?.summary ?? "", /billing unavailable/);
});
