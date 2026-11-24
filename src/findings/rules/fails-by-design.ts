import type { Rule } from "../types.js";
import { ev, pct, savings, slug, withModel } from "../util.js";

export const failsByDesign: Rule = {
  id: "fails-by-design",
  title: "Workflows that fail as a normal outcome",
  description:
    "A workflow that fails most of the time, fast, and is not a required gate is usually reporting a state (not ready, nothing to do) with exit 1. Red checks train people to ignore failures and invite reruns.",
  detect(m) {
    const findings = [];
    for (const [wi, row] of m.workflows.entries()) {
      if (row.runs < 10 || (row.failureRate ?? 0) < 0.4 || row.group === "required") continue;
      if ((row.failedRunMinutesP50 ?? Infinity) > 3) continue;
      const fi = m.workflowFiles.findIndex((f) => f.path === row.path);
      const job = m.workflowFiles[fi]?.jobs[0];
      const cmd = job?.commands[job.commands.length - 1] ?? "<check command>";
      findings.push({
        id: `fails-by-design:${slug(row.name)}`,
        ruleId: "fails-by-design",
        title: `Make "${row.name}" exit 0 and report its state`,
        kind: "fix" as const,
        subject: row.name,
        summary: `"${row.name}" failed ${row.failed} of ${row.runs} runs (${pct(row.failureRate)}), with failed runs taking ${row.failedRunMinutesP50} min at the median: it looks like it exits 1 for a normal state.`,
        evidence: [
          ev("Failure rate", row.failureRate, `workflows[${wi}].failureRate`),
          ev("Failed runs", row.failed, `workflows[${wi}].failed`),
          ev("Failed-run minutes, p50", row.failedRunMinutesP50, `workflows[${wi}].failedRunMinutesP50`),
          ev("Reruns", row.reruns, `workflows[${wi}].reruns`),
        ],
        savings: savings(m, row.reruns * (row.meanBillable ?? 1), "Billable minutes of reruns of this workflow; the larger gain is red checks that mean something again."),
        confidence: withModel(m, "low"),
        fix: {
          summary: "Exit 0 for expected states and write the state to the job summary; fail only on real errors.",
          steps: ["Return a non-zero status only when the check itself breaks.", "Write the state (ready, not ready, skipped) to $GITHUB_STEP_SUMMARY or a step output that later jobs read."],
          yaml: [
            "     steps:",
            `-      - run: ${cmd}`,
            "+      - run: |",
            `+          if ${cmd}; then state=ready; else state="not ready"; fi`,
            '+          echo "State: $state" >> "$GITHUB_STEP_SUMMARY"',
          ].join("\n"),
        },
      });
    }
    return findings.length ? { status: "findings", findings } : { status: "not-triggered", reason: "no non-required workflow fails fast in 40%+ of runs" };
  },
};
