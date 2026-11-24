import type { Rule } from "../types.js";
import { ev, savings, slug, withModel } from "../util.js";

export const missingCancellation: Rule = {
  id: "missing-cancellation",
  title: "PR workflows that let superseded runs finish",
  description:
    "A PR workflow without a concurrency group that cancels in-progress runs keeps running on old commits after a new push. Counts runs still going when a newer run of the same workflow started for the same PR.",
  detect(m) {
    const findings = [];
    const quiet: string[] = [];
    for (const [fi, file] of m.workflowFiles.entries()) {
      if (!file.prTriggered || file.cancelsSuperseded) continue;
      const wi = m.workflows.findIndex((w) => w.path === file.path);
      const row = m.workflows[wi];
      if (!row) continue;
      if (row.superseded.runs === 0) {
        quiet.push(file.name);
        continue;
      }
      const wallPerRun = row.wallMinutes / Math.max(1, row.runs);
      const ratio = row.meanBillable && wallPerRun ? row.meanBillable / wallPerRun : 1;
      const minutes = row.superseded.wallMinutes * ratio;
      findings.push({
        id: `missing-cancellation:${slug(file.name)}`,
        ruleId: "missing-cancellation",
        title: `Cancel superseded runs of "${file.name}"`,
        kind: "fix" as const,
        subject: file.name,
        summary: `"${file.name}" has no concurrency group with cancel-in-progress. ${row.superseded.runs} runs kept going for ${row.superseded.wallMinutes} wall minutes after a newer push to the same PR.`,
        evidence: [
          ev("Concurrency", file.concurrency ? `group without cancel-in-progress` : "none", `workflowFiles[${fi}].concurrency`),
          ev("Superseded runs", row.superseded.runs, `workflows[${wi}].superseded.runs`),
          ev("Wall minutes after being superseded", row.superseded.wallMinutes, `workflows[${wi}].superseded.wallMinutes`),
        ],
        savings: savings(m, minutes, "Wall minutes superseded runs kept going after the newer run started, x the workflow's billable-to-wall ratio (parallel jobs bill more than wall time)."),
        confidence: withModel(m, "medium"),
        fix: {
          summary: "Add a per-PR concurrency group that cancels in-progress runs on pull requests.",
          steps: ["Add the block at the top level of the workflow.", "Keep pushes to the default branch uncancelled so every merged commit gets a result."],
          yaml: [
            ` # ${file.path}`,
            "+concurrency:",
            "+  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
            "+  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
          ].join("\n"),
        },
      });
    }
    if (findings.length) return { status: "findings", findings };
    return { status: "not-triggered", reason: quiet.length ? `${quiet.join(", ")} lack cancel-in-progress but had no overlapping runs in the window` : "every PR workflow cancels superseded runs" };
  },
};
