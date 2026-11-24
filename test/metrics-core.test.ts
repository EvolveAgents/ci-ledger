import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { buildMetrics, METRICS_SCHEMA_VERSION } from "../src/metrics/index.js";
import { syntheticDataset } from "./helpers/dataset.js";

const now = new Date("2026-10-31T01:00:00Z");

test("metrics.json carries its schema version, window and page-one model numbers", async () => {
  const m = buildMetrics(await syntheticDataset(), defaultConfig(), now);
  assert.equal(m.schema, "ci-ledger/metrics");
  assert.equal(m.schemaVersion, METRICS_SCHEMA_VERSION);
  assert.equal(m.window.since, "2026-10-01");
  assert.equal(m.window.days, 30);
  assert.equal(m.window.runs, m.workflows.reduce((s, w) => s + w.runs, 0));
  assert.equal(m.model.confidence, "high");
  assert.ok(Math.abs(m.model.errorPct!) < 15);
  assert.equal(m.sources.billing, "actual");
  assert.equal(m.sources.prTimelines, "graphql");
  JSON.parse(JSON.stringify(m));
});

test("per-workflow rows, groups, retriggers and superseded runs", async () => {
  const m = buildMetrics(await syntheticDataset(), defaultConfig(), now);
  const row = (name: string) => m.workflows.find((w) => w.name === name)!;
  assert.equal(row("CI").group, "required");
  assert.equal(row("E2E").group, "required");
  assert.equal(row("PR Labeler").group, "pr-automation");
  assert.equal(row("Release Status").group, "pr-automation");
  assert.equal(row("CodeQL").group, "code-scanning");
  assert.ok(row("Release Status").failureRate! > 0.5);
  assert.ok(row("PR Labeler").sameHeadRetriggers.runs > 0, "label events re-run the labeler on the same head");
  assert.ok(row("CI").reruns > 0);
  assert.ok(row("CI").p50! > 3 && row("CI").p90! >= row("CI").p50!);
  assert.deepEqual(Object.keys(row("CI").events).sort(), ["merge_group", "pull_request", "push"]);
  const files = m.workflowFiles.find((f) => f.path.endsWith("ci.yml"))!;
  assert.equal(files.cancelsSuperseded, false);
  assert.deepEqual(files.jobs.find((j) => j.id === "test")?.testCommands, ["npm test"]);
  assert.deepEqual(m.workflowFiles.find((f) => f.path.endsWith("labeler.yml"))?.helperTriggers, ["labeled", "unlabeled", "edited"]);
});

test("required checks, fan-out, CI per PR and rollups", async () => {
  const m = buildMetrics(await syntheticDataset(), defaultConfig(), now);
  assert.deepEqual(m.requiredChecks.checks.map((c) => c.context), ["build", "e2e", "test"]);
  assert.ok(m.requiredChecks.checks.every((c) => c.jobsSampled > 0));
  assert.ok(m.fanOut.runsPerHead.p50! >= 4, "each PR head fans out to several workflows");
  assert.ok(m.ciPerPr.prsWithRuns > 50);
  assert.equal(m.ciPerPr.ambiguousRuns, 0);
  assert.ok(m.rollups.weekly.length >= 4);
  assert.deepEqual(m.rollups.monthly.map((r) => r.period), ["2026-10"]);
  const weeklyRuns = m.rollups.weekly.reduce((s, r) => s + r.runs, 0);
  assert.equal(weeklyRuns, m.window.runs);
  const est = m.rollups.monthly[0]!.estimatedBillable;
  assert.ok(Math.abs(est - m.model.estimatedBillableMinutes) < 1, "rollups add up to the estimate");
});

test("billing by month and repo, month-to-date, and the billable estimate detail", async () => {
  const m = buildMetrics(await syntheticDataset(), defaultConfig(), now);
  assert.equal(m.billing.available, true);
  assert.deepEqual(m.billing.byMonth.map((r) => r.month), ["2026-10"]);
  assert.deepEqual(m.billing.byRepo.map((r) => r.repo), ["example-org/widgets", "example-org/docs-site"]);
  assert.equal(m.billing.monthToDate?.daysElapsed, 30);
  assert.ok(m.billable.strata.length >= 8);
  assert.ok(m.billable.outliers.runs[0]!.wallMinutes >= 120);
  assert.ok(m.billable.jobQueueWaitSeconds.n > 100);
  assert.ok(m.billable.slowestSteps.length > 0);
  assert.ok(m.billable.shortJobs.shortShare! > 0.2);
  assert.ok(m.billable.shortJobs.estimatedWasteMinutes > 100);
  assert.ok(m.billable.byJob.some((j) => j.workflow === "CI" && j.job === "lint" && j.shortShare === 1));
});

test("without billing access the model is labeled low confidence", async () => {
  const m = buildMetrics(await syntheticDataset({ billing: false }), defaultConfig(), now);
  assert.equal(m.model.confidence, "low");
  assert.equal(m.model.errorPct, null);
  assert.match(m.model.confidenceReason, /runtime-based estimate only/);
  assert.equal(m.billing.available, false);
});
