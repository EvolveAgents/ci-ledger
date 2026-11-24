import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { buildMetrics } from "../src/metrics/index.js";
import { RULES, runFindings } from "../src/findings/index.js";
import { parsePath, resolvePath } from "../src/util/path.js";
import type { Dataset } from "../src/types.js";
import { syntheticDataset } from "./helpers/dataset.js";

const now = new Date("2026-10-31T01:00:00Z");
const config = defaultConfig();

test("metrics paths parse indices and quoted keys", () => {
  assert.deepEqual(parsePath('revisions.bySize["1200+"].prs'), ["revisions", "bySize", "1200+", "prs"]);
  assert.deepEqual(parsePath("workflows[2].events.push"), ["workflows", 2, "events", "push"]);
  assert.equal(resolvePath({ a: [{ b: 3 }] }, "a[0].b"), 3);
  assert.equal(resolvePath({ a: 1 }, "a.b.c"), undefined);
});

test("the v1 catalog has the 12 rules", () => {
  assert.deepEqual(RULES.map((r) => r.id), [
    "rounding-waste", "helper-fanout", "duplicate-suites", "fails-by-design", "queue-ejections", "conflict-hotspots",
    "revision-churn", "lead-time-split", "stale-prs", "cap-forecast", "missing-cancellation", "agent-report",
  ]);
});

test("flow rules fire on the synthetic repo with resolvable evidence", async () => {
  const m = buildMetrics(await syntheticDataset(), config, now);
  const d = runFindings(m, config, now);
  const byId = new Map(d.findings.map((f) => [f.id, f]));
  for (const id of ["queue-ejections", "conflict-hotspots", "revision-churn", "lead-time-split", "stale-prs", "agent-report"]) {
    const f = byId.get(id);
    assert.ok(f, `${id} missing; not triggered: ${JSON.stringify(d.notTriggered)}`);
    for (const e of f.evidence) {
      const v = resolvePath(m, e.metric);
      assert.notEqual(v, undefined, `${id}: ${e.metric}`);
      if (typeof e.value === "number" && typeof v === "number") assert.equal(v, e.value, `${id}: ${e.metric}`);
    }
  }
  assert.match(byId.get("conflict-hotspots")!.title, /src\/registry\.ts|package-lock\.json/);
  assert.equal(byId.get("agent-report")!.kind, "report");
  assert.ok(byId.get("agent-report")!.table!.rows.length >= 5);
  assert.ok(byId.get("stale-prs")!.table!.rows.length >= 5);
  assert.ok(byId.get("queue-ejections")!.savings.minutesPer30d > 0);
});

test("queue rules are skipped, with the reason, when there is no merge queue", async () => {
  const data = await syntheticDataset();
  const noQueue: Dataset = {
    ...data,
    setup: { ...data.setup, mergeQueue: false },
    runs: data.runs.filter((r) => r.event !== "merge_group"),
    prs: data.prs.map((p) => ({ ...p, timeline: p.timeline.filter((e) => e.type !== "queue_added" && e.type !== "queue_removed") })),
  };
  const d = runFindings(buildMetrics(noQueue, config, now), config, now);
  const skipped = d.skipped.map((s) => s.ruleId).sort();
  assert.deepEqual(skipped, ["conflict-hotspots", "queue-ejections"]);
  assert.ok(d.skipped.every((s) => /Enterprise Cloud/.test(s.reason)));
  assert.ok(d.findings.some((f) => f.id === "lead-time-split"), "lead time still splits without a queue");
});

test("a rule that throws is reported as skipped instead of breaking the run", async () => {
  const m = buildMetrics(await syntheticDataset(), config, now);
  const broken = { ...m, leadTime: undefined } as unknown as typeof m;
  const d = runFindings(broken, config, now);
  assert.ok(d.skipped.some((s) => s.ruleId === "lead-time-split" && /rule failed/.test(s.reason)));
});
