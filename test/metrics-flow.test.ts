import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { buildMetrics } from "../src/metrics/index.js";
import { reasonKey } from "../src/metrics/flow.js";
import type { Dataset } from "../src/types.js";
import { syntheticDataset } from "./helpers/dataset.js";

const now = new Date("2026-10-31T01:00:00Z");
const metrics = async () => buildMetrics(await syntheticDataset(), defaultConfig(), now);

test("merge-queue removal reasons are normalized", () => {
  assert.equal(reasonKey("MERGE_CONFLICT"), "merge_conflict");
  assert.equal(reasonKey("FAILED_CHECKS"), "failed_checks");
  assert.equal(reasonKey("Manually removed"), "manual");
  assert.equal(reasonKey(null), "unknown");
});

test("merge queue: entries, exits by reason, kick-outs, time in queue, first-try merges, conflict files", async () => {
  const q = (await metrics()).mergeQueue;
  assert.equal(q.enabled, true);
  assert.equal(q.skippedReason, null);
  assert.ok(q.entries > 50);
  assert.equal(q.entries, q.merged + q.removed + q.stillQueued);
  assert.deepEqual(Object.keys(q.exitsByReason).sort(), ["failed_checks", "merge_conflict"]);
  assert.equal(q.kickOuts, q.removed);
  assert.ok(q.kickOutRate! > 0.1 && q.kickOutRate! < 0.6);
  assert.ok(q.minutesInQueue.merged.n > 0 && q.minutesInQueue.ejected.n > 0);
  assert.ok(q.entriesPerMergedPr.mean! > 1);
  assert.ok(q.mergedFirstTryRate! > 0.3 && q.mergedFirstTryRate! < 1);
  assert.equal(q.weekly.reduce((s, w) => s + w.entries, 0), q.entries);
  assert.equal(q.weekly.reduce((s, w) => s + w.mergedFirstTry, 0), q.mergedFirstTry, "weekly first-try merges add up");
  assert.equal(q.weekly.reduce((s, w) => s + w.mergedPrs, 0), q.mergedPrs);
  assert.equal(q.kickOutRate, Math.round((q.kickOuts / (q.merged + q.removed)) * 10000) / 10000);
  assert.ok(q.byAgent.some((a) => a.agent === "codex"));
  assert.ok(["src/registry.ts", "package-lock.json"].includes(q.conflictFiles[0]!.path));
});

test("merge groups: failures, failing check combinations and minutes on failed groups", async () => {
  const g = (await metrics()).mergeGroups;
  assert.ok(g.groups > 40);
  assert.ok(g.failed > 0);
  assert.ok(g.failedCheckCombinations.length > 0);
  assert.ok(g.failedGroupMinutes.estimatedBillable > 0);
  assert.equal(g.workflowsPerGroup.p50, 2);
});

test("revisions per merged PR by agent, size bucket and month", async () => {
  const r = (await metrics()).revisions;
  assert.ok(r.overall.prs > 40);
  assert.ok(r.overall.headsPushed.mean! > 1);
  assert.ok(r.overall.catchUpMerges.max! >= 1);
  assert.ok(r.overall.botReviews.mean! > 0);
  assert.ok(r.overall.humanReviews.mean! >= 1);
  assert.deepEqual(Object.keys(r.bySize).filter((k) => ["<100", "100-299", "300-1199", "1200+"].includes(k)), Object.keys(r.bySize));
  assert.ok(r.bySize["1200+"]!.headsPushed.mean! > r.bySize["<100"]!.headsPushed.mean!);
  assert.deepEqual(Object.keys(r.byMonth), ["2026-10"]);
  assert.ok(r.byAgent.copilot && r.byAgent.none);
});

test("lead time stages, open-PR ages and stale PRs", async () => {
  const l = (await metrics()).leadTime;
  assert.ok(l.createdToMerged.p50! > l.firstQueueToMerged.p50!);
  assert.ok(l.createdToFirstQueue.n > 0 && l.lastHumanApprovalToMerged.n > 0);
  assert.ok(l.openPrAgeDays.max! > 30);
  assert.ok(l.stale.count >= 5);
  assert.ok(l.stale.behindBase >= 5);
  assert.ok(l.stale.prs[0]!.idleDays >= l.stale.prs[1]!.idleDays);
});

test("open-PR ages and stale PRs use PR state as of the window end", async () => {
  const data = await syntheticDataset();
  const early: Dataset = { ...data, window: { since: "2026-10-01", until: "2026-10-10" } };
  const l = buildMetrics(early, defaultConfig(), now).leadTime;
  assert.equal(l.asOf, "2026-10-10T23:59:59.000Z");
  const openThen = data.prs.filter((p) => p.createdAt <= l.asOf && !(p.closedAt && p.closedAt <= l.asOf));
  assert.equal(l.openPrAgeDays.n, openThen.length);
  assert.ok(openThen.some((p) => p.state !== "open"), "includes PRs merged after the window");
  assert.ok(l.stale.prs.every((p) => p.idleDays >= 14));
});

test("agents: PRs, CI minutes and rework per agent add up", async () => {
  const m = await metrics();
  const total = m.agents.reduce((s, a) => s + a.estimatedBillable, 0);
  const linked = m.ciPerPr.estimatedBillable.mean! * m.ciPerPr.estimatedBillable.n;
  assert.ok(Math.abs(total - linked) < 2);
  assert.ok(m.agents.find((a) => a.agent === "copilot")!.headsPerMergedPr! > m.agents.find((a) => a.agent === "none")!.headsPerMergedPr!);
});

test("without a merge queue the section says why", async () => {
  const data = await syntheticDataset();
  const noQueue: Dataset = {
    ...data,
    setup: { ...data.setup, mergeQueue: false },
    runs: data.runs.filter((r) => r.event !== "merge_group"),
    prs: data.prs.map((p) => ({ ...p, timeline: p.timeline.filter((e) => e.type !== "queue_added" && e.type !== "queue_removed") })),
  };
  const q = buildMetrics(noQueue, defaultConfig(), now).mergeQueue;
  assert.equal(q.enabled, false);
  assert.match(q.skippedReason ?? "", /Enterprise Cloud/);
});
