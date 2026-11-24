import type { Rule } from "../types.js";
import { ev, pct, savings, withModel } from "../util.js";

export const queueEjections: Rule = {
  id: "queue-ejections",
  title: "Merge-queue ejections from failing checks",
  description:
    "Failed merge groups burn a full run of every queue workflow and send the PR back to the end of the queue. Breaks ejections down by reason and by the checks that failed. Needs a merge queue.",
  detect(m) {
    const q = m.mergeQueue;
    if (!q.enabled) return { status: "skipped", reason: q.skippedReason ?? "no merge queue" };
    const g = m.mergeGroups;
    if (q.kickOuts === 0 && g.failed === 0) return { status: "not-triggered", reason: `${q.entries} queue entries, none ejected` };
    const top = g.failedCheckCombinations[0];
    const topWorkflow = top?.checks.split(" + ")[0]?.split(" / ")[0];
    const runsOnPrs = m.workflows.find((w) => w.name === topWorkflow)?.events.pull_request ?? 0;
    return {
      status: "findings",
      findings: [{
        id: "queue-ejections",
        ruleId: "queue-ejections",
        title: top ? `Catch "${top.checks}" failures before the merge queue` : "Cut merge-queue ejections",
        kind: "fix",
        subject: top?.checks,
        summary: `${q.kickOuts} of ${q.entries} queue entries were ejected (${pct(q.kickOutRate)}); ${g.failed} of ${g.groups} merge groups failed and burned ~${g.failedGroupMinutes.estimatedBillable} billable minutes.${top ? ` The most common failure was ${top.checks} (${top.groups} groups).` : ""}`,
        evidence: [
          ev("Queue entries", q.entries, "mergeQueue.entries"),
          ev("Kick-out rate", q.kickOutRate, "mergeQueue.kickOutRate"),
          ev("Failed merge groups", g.failed, "mergeGroups.failed"),
          ev("Billable minutes on failed groups (est.)", g.failedGroupMinutes.estimatedBillable, "mergeGroups.failedGroupMinutes.estimatedBillable"),
          ev("Ejections for failed checks", q.exitsByReason.failed_checks ?? 0, "mergeQueue.exitsByReason.failed_checks"),
        ],
        table: {
          columns: ["Failed checks", "Groups"],
          rows: g.failedCheckCombinations.slice(0, 10).map((c) => [c.checks, c.groups]),
        },
        savings: savings(m, g.failedGroupMinutes.estimatedBillable, "Estimated billable minutes of merge groups that failed; catching the failure on the PR avoids the group run."),
        confidence: withModel(m, "medium"),
        fix: {
          summary: top ? `Run ${top.checks} on the PR, against the latest base, before it can enter the queue.` : "Run the failing checks on the PR before it enters the queue.",
          steps: [
            runsOnPrs
              ? `${topWorkflow} already runs on pull_request: make it a required check, and require branches to be up to date (or rebase) so PR results match what the queue tests.`
              : `Add a pull_request trigger to ${topWorkflow ?? "the failing workflow"} and make it required, so the queue only sees PRs that already passed it.`,
            "Track flaky tests separately: a check that fails in the queue and passes on retry is noise, not signal.",
          ],
          yaml: runsOnPrs ? undefined : [" on:", "+  pull_request:", "   merge_group:"].join("\n"),
        },
      }],
    };
  },
};
