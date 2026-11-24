import type { Rule } from "../types.js";
import { ev, savings, slug, withModel } from "../util.js";

export const helperFanout: Rule = {
  id: "helper-fanout",
  title: "Helper workflows fanning out on PR activity",
  description:
    "Workflows triggered by labeled, edited or workflow_run events run again on PR activity that does not change code. Counts first-attempt runs on a head SHA the workflow already ran on, plus the round-up overhead of workflow_run helpers.",
  detect(m) {
    const findings = [];
    for (const [fi, file] of m.workflowFiles.entries()) {
      if (!file.helperTriggers.length) continue;
      const wi = m.workflows.findIndex((w) => w.path === file.path);
      const row = m.workflows[wi];
      if (!row) continue;
      const retrigger = row.sameHeadRetriggers.estimatedBillable;
      // workflow_run helpers fire after every run of the parent, on every branch. Guarding them to the
      // default branch removes the rest (an assumption, hence low confidence).
      const offDefault = file.helperTriggers.includes("workflow_run") ? row.runs - row.defaultBranchRuns : 0;
      const chained = offDefault * (row.meanBillable ?? 0);
      const minutes = retrigger + chained;
      if (minutes < 5) continue;
      const prTypes = file.helperTriggers.filter((t) => t !== "workflow_run" && t !== "issue_comment");
      const event = Object.keys(file.triggers).find((e) => e === "pull_request_target" || e === "pull_request");
      const keep = event ? (file.triggers[event] ?? []).filter((t) => !prTypes.includes(t)) : [];
      findings.push({
        id: `helper-fanout:${slug(row.name)}`,
        ruleId: "helper-fanout",
        title: `Narrow the triggers of "${row.name}"`,
        kind: "fix" as const,
        subject: row.name,
        summary: [
          `"${row.name}" runs on ${file.helperTriggers.join(", ")}.`,
          row.sameHeadRetriggers.runs ? `${row.sameHeadRetriggers.runs} of its ${row.runs} runs re-ran on a head it had already checked.` : "",
          offDefault ? `${offDefault} of its ${row.runs} runs followed a parent run on a branch other than ${m.repo.defaultBranch}.` : "",
        ].filter(Boolean).join(" "),
        evidence: [
          ev("Runs", row.runs, `workflows[${wi}].runs`),
          ev("Re-runs on an unchanged head", row.sameHeadRetriggers.runs, `workflows[${wi}].sameHeadRetriggers.runs`),
          ev("Their billable minutes (est.)", row.sameHeadRetriggers.estimatedBillable, `workflows[${wi}].sameHeadRetriggers.estimatedBillable`),
          ev(`Runs on ${m.repo.defaultBranch}`, row.defaultBranchRuns, `workflows[${wi}].defaultBranchRuns`),
          ev("Helper triggers", file.helperTriggers.join(", "), `workflowFiles[${fi}].helperTriggers`),
        ],
        savings: savings(m, minutes, "Billable minutes (est.) of runs on an already-checked head, plus, for workflow_run helpers, runs that followed a parent run off the default branch, assuming the helper only matters there."),
        confidence: withModel(m, chained > retrigger ? "low" : "medium"),
        fix: {
          summary: "Trigger only on the activity types the workflow needs, merge helpers into one workflow, and guard jobs with `if:`.",
          steps: [
            ...(prTypes.length ? [`Drop ${prTypes.join(", ")} from the ${event} types unless the job reads labels or the PR body.`] : []),
            ...(file.helperTriggers.includes("workflow_run")
              ? [`If it only matters for ${m.repo.defaultBranch}, guard the job on the parent's branch, or run it as a final job of the parent workflow with \`needs:\`.`]
              : []),
            "Where a label must trigger it, add `if: github.event.label.name == '<label>'` so other labels skip the job.",
          ],
          yaml: event && prTypes.length
            ? [" on:", `   ${event}:`, `-    types: [${(file.triggers[event] ?? []).join(", ")}]`, `+    types: [${keep.join(", ") || "opened, synchronize"}]`].join("\n")
            : [" jobs:", `   ${m.workflowFiles[fi]?.jobs[0]?.id ?? "check"}:`, `+    if: github.event.workflow_run.head_branch == '${m.repo.defaultBranch}'`].join("\n"),
        },
      });
    }
    return findings.length ? { status: "findings", findings } : { status: "not-triggered", reason: "no helper workflow spent 5+ minutes on re-triggers" };
  },
};
