import type { Rule } from "../types.js";
import { ev, noSavings } from "../util.js";

export const leadTimeSplit: Rule = {
  id: "lead-time-split",
  title: "Where PR lead time goes",
  description:
    "Splits created-to-merged time into stages (before the first queue entry or approval, and from there to merge) and points at the slowest stage. It saves hours of waiting rather than billed minutes.",
  detect(m) {
    const l = m.leadTime;
    if (!l.createdToMerged.n) return { status: "not-triggered", reason: "no PRs merged in the window" };
    const useQueue = m.mergeQueue.enabled && l.firstQueueToMerged.n > 0;
    const stages = useQueue
      ? [
          { name: "open to first queue entry", d: l.createdToFirstQueue, metric: "leadTime.createdToFirstQueue.p50", advice: "Shorten review: smaller PRs, auto-assigned reviewers, a review-time target, and agent PRs that arrive green." },
          { name: "first queue entry to merge", d: l.firstQueueToMerged, metric: "leadTime.firstQueueToMerged.p50", advice: "Speed up the queue: fewer ejections (see queue fixes), faster required checks, a larger merge-group size." },
        ]
      : [
          { name: "open to last approval", d: { p50: (l.createdToMerged.p50 ?? 0) - (l.lastHumanApprovalToMerged.p50 ?? 0) }, metric: "leadTime.createdToMerged.p50", advice: "Shorten review: smaller PRs, auto-assigned reviewers and a review-time target." },
          { name: "last approval to merge", d: l.lastHumanApprovalToMerged, metric: "leadTime.lastHumanApprovalToMerged.p50", advice: "Turn on auto-merge so approved, green PRs merge without waiting for someone to click." },
        ];
    const slowest = [...stages].sort((a, b) => (b.d.p50 ?? 0) - (a.d.p50 ?? 0))[0]!;
    const share = l.createdToMerged.p50 ? Math.round(((slowest.d.p50 ?? 0) / l.createdToMerged.p50) * 100) : null;
    return {
      status: "findings",
      findings: [{
        id: "lead-time-split",
        ruleId: "lead-time-split",
        title: `Aim at "${slowest.name}", the slowest stage of lead time`,
        kind: "fix",
        subject: slowest.name,
        summary: `Median PR lead time is ${l.createdToMerged.p50} h; "${slowest.name}" takes ${Math.round((slowest.d.p50 ?? 0) * 10) / 10} h of it${share !== null ? ` (~${share}% of the median)` : ""}.`,
        evidence: [
          ev("Created to merged, p50 (h)", l.createdToMerged.p50, "leadTime.createdToMerged.p50"),
          ...stages.map((s) => ev(`${s.name}, p50 (h)`, Math.round((s.d.p50 ?? 0) * 10) / 10, s.metric)),
          ev("Last human approval to merged, p50 (h)", l.lastHumanApprovalToMerged.p50, "leadTime.lastHumanApprovalToMerged.p50"),
        ],
        table: {
          columns: ["Agent", "Merged PRs", "Created to merged p50 (h)", "p90 (h)"],
          rows: Object.entries(l.createdToMergedByAgent).map(([a, d]) => [a, d.n, d.p50, d.p90]),
        },
        savings: noSavings("Saves lead time (hours of waiting), not billed minutes."),
        confidence: "medium",
        fix: { summary: slowest.advice, steps: [slowest.advice, "Re-run the audit after a change and compare this stage's p50."] },
      }],
    };
  },
};
