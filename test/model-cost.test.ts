import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { compareWithBilling, estimateBillable, jobMinutes, runCost, skuFor } from "../src/model/cost.js";
import type { Dataset, Job, Run } from "../src/types.js";
import { syntheticDataset } from "./helpers/dataset.js";

const config = defaultConfig();
const at = (s: number) => new Date(Date.UTC(2026, 2, 1) + s * 1000).toISOString();
function job(seconds: number, labels = ["ubuntu-latest"], runId = 1): Job {
  return { id: Math.floor(Math.random() * 1e9), runId, name: "j", status: "completed", conclusion: "success",
    createdAt: at(0), startedAt: at(0), completedAt: at(seconds), labels, runnerGroup: null, steps: [] };
}
function run(id: number, name: string, minutes: number): Run {
  return { id, workflowId: 1, name, path: "", event: "push", status: "completed", conclusion: "success", headBranch: "main",
    headSha: "s", runAttempt: 1, createdAt: at(id), runStartedAt: at(id), updatedAt: at(id + minutes * 60),
    actor: null, triggeringActor: null, pullRequests: [], titlePr: null };
}

test("each job is rounded up to a whole minute", () => {
  assert.deepEqual(jobMinutes(job(59)).billable, 1);
  assert.deepEqual(jobMinutes(job(61)).billable, 2);
  assert.deepEqual(jobMinutes(job(120)).billable, 2);
  assert.deepEqual(jobMinutes(job(0)).billable, 0);
});

test("runner SKUs come from the rate table; self-hosted is counted but not priced", () => {
  assert.equal(skuFor(job(1, ["ubuntu-latest"]), config.rates), "linux-2-core");
  assert.equal(skuFor(job(1, ["self-hosted", "linux"]), config.rates), "self-hosted");
  assert.equal(skuFor(job(1, ["macos-latest"]), config.rates), "unpriced");
  const cost = runCost([job(30), job(90), job(600, ["self-hosted"])], config.rates);
  assert.equal(cost.billable, 3);
  assert.equal(cost.real, 2);
  assert.equal(cost.roundingWaste, 1);
  assert.deepEqual(cost.bySku, { "linux-2-core": 3, "self-hosted": 10 });
});

test("strata are estimated as mean sampled billable x runs; small strata and outliers stay separate", () => {
  const runs = [
    ...Array.from({ length: 10 }, (_, i) => run(i + 1, "CI", 3)),
    run(50, "Docs", 1), run(51, "Docs", 1),
    run(60, "CI", 200),
  ];
  const data = {
    repo: { owner: "o", name: "r", fullName: "o/r", private: true, defaultBranch: "main" },
    window: { since: "2026-03-01", until: "2026-03-01" },
    runs,
    jobs: { "1": [job(150, undefined, 1)], "2": [job(170, undefined, 2)], "3": [job(30, undefined, 3), job(40, undefined, 3)], "60": [job(12000, undefined, 60)] },
  } as unknown as Dataset;
  const est = estimateBillable(data, config);
  const ci = est.strata.find((s) => s.workflow === "CI")!;
  assert.equal(ci.runs, 10);
  assert.equal(ci.sampled, 3);
  assert.equal(ci.meanBillable, 2.67);
  assert.equal(ci.estimatedBillable, 26.7);
  assert.equal(est.unsampled.runs, 2);
  assert.deepEqual(est.outliers.runs.map((o) => [o.id, o.billable]), [[60, 200]]);
  assert.equal(est.totals.billableMinutes, 226.7);
  assert.equal(est.totals.usd, 1.36);

  const cmp = compareWithBilling(est, { status: "ok", org: "o", months: [], items: [
    { date: "2026-03-01", product: "actions", sku: "linux", unitType: "Minutes", repositoryName: "o/r", quantity: 250, grossAmount: 1.5, netAmount: 0 },
    { date: "2026-03-01", product: "actions", sku: "linux", unitType: "Minutes", repositoryName: "o/other", quantity: 999, grossAmount: 6, netAmount: 6 },
  ] }, data);
  assert.equal(cmp.actualMinutes, 250);
  assert.equal(cmp.errorPct, -9.3);
  assert.equal(cmp.confidence, "high");
  const none = compareWithBilling(est, { status: "unavailable", reason: "403", org: "o", months: [], items: [] }, data);
  assert.equal(none.confidence, "low");
  assert.equal(none.errorPct, null);
});

test("public repositories cost nothing on standard runners", () => {
  const data = { repo: { owner: "o", name: "r", fullName: "o/r", private: false, defaultBranch: "main" },
    window: { since: "2026-03-01", until: "2026-03-01" },
    runs: Array.from({ length: 5 }, (_, i) => run(i + 1, "CI", 3)), jobs: { "1": [job(150)] } } as unknown as Dataset;
  assert.equal(estimateBillable(data, config).totals.usd, 0);
});

test("on the synthetic repo the estimate lands close to billing", async () => {
  const data = await syntheticDataset();
  const est = estimateBillable(data, config);
  const cmp = compareWithBilling(est, data.billing, data);
  assert.ok(cmp.actualMinutes! > 5000);
  assert.ok(Math.abs(cmp.errorPct!) < 15, `error ${cmp.errorPct}%`);
  assert.ok(est.totals.selfHostedMinutes > 0);
  assert.ok(est.totals.roundingWasteMinutes > 0);
});
