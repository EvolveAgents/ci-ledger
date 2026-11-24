import type { Rule } from "../types.js";
import { ev, savings, slug, withModel } from "../util.js";

export const duplicateSuites: Rule = {
  id: "duplicate-suites",
  title: "The same test command in two required workflows",
  description:
    "Finds a test command (npm test, pytest, go test and similar) that runs in more than one PR-triggered workflow, so every PR pays for the suite twice.",
  detect(m) {
    const where = new Map<string, Array<{ fi: number; file: (typeof m.workflowFiles)[number]; job: (typeof m.workflowFiles)[number]["jobs"][number] }>>();
    for (const [fi, file] of m.workflowFiles.entries()) {
      if (!file.prTriggered && !("merge_group" in file.triggers)) continue;
      for (const job of file.jobs) for (const cmd of job.testCommands) where.set(cmd, [...(where.get(cmd) ?? []), { fi, file, job }]);
    }
    const findings = [];
    for (const [cmd, places] of where) {
      if (new Set(places.map((p) => p.file.path)).size < 2) continue;
      // Keep the suite where it is the job's main command; drop it where the job does other work too.
      const sorted = [...places].sort((a, b) => a.job.commands.length - b.job.commands.length);
      const keep = sorted[0]!;
      for (const drop of sorted.slice(1).filter((p) => p.file.path !== keep.file.path)) {
        const wi = m.workflows.findIndex((w) => w.path === drop.file.path);
        const row = m.workflows[wi];
        const step = m.billable.testSteps.find((s) => s.workflow === (row?.name ?? drop.file.name) && s.job === drop.job.name && s.command === cmd);
        const si = step ? m.billable.testSteps.indexOf(step) : -1;
        const prRuns = row ? (row.events.pull_request ?? 0) + (row.events.merge_group ?? 0) + (row.events.pull_request_target ?? 0) : 0;
        const minutes = step ? (step.meanSeconds / 60) * prRuns : 0;
        findings.push({
          id: `duplicate-suites:${slug(drop.file.name)}:${slug(cmd)}`,
          ruleId: "duplicate-suites",
          title: `Run "${cmd}" once, not in both "${keep.file.name}" and "${drop.file.name}"`,
          kind: "fix" as const,
          subject: drop.file.name,
          summary: `"${cmd}" runs in ${keep.file.name} / ${keep.job.name} and again in ${drop.file.name} / ${drop.job.name}${step ? `, where it takes ~${Math.round(step.meanSeconds)}s per run` : ""}.`,
          evidence: [
            ev("Kept in", `${keep.file.name} / ${keep.job.name}`, `workflowFiles[${keep.fi}].jobs`),
            ev("Duplicated in", `${drop.file.name} / ${drop.job.name}`, `workflowFiles[${drop.fi}].jobs`),
            ev("Step time, mean (s)", step?.meanSeconds ?? null, si >= 0 ? `billable.testSteps[${si}].meanSeconds` : "billable.testSteps"),
            ev("PR and queue runs of the duplicate", prRuns, wi >= 0 ? `workflows[${wi}].events` : "workflows"),
          ],
          savings: savings(m, minutes, "Mean sampled time of the duplicated step x PR and merge-queue runs of the workflow it is removed from."),
          confidence: withModel(m, step ? "medium" : "low"),
          fix: {
            summary: `Remove "${cmd}" from ${drop.file.name} / ${drop.job.name}; ${keep.file.name} / ${keep.job.name} already runs it.`,
            steps: [
              `Delete the step from ${drop.file.path}.`,
              `If ${drop.job.name} needs the suite to pass first, add \`needs:\` on a shared job or make ${keep.job.name} a required check instead.`,
            ],
            yaml: [` # ${drop.file.path}`, ` jobs:`, `   ${drop.job.id}:`, `     steps:`, `-      - run: ${cmd}`].join("\n"),
          },
        });
      }
    }
    return findings.length ? { status: "findings", findings } : { status: "not-triggered", reason: "no test command appears in two PR workflows" };
  },
};
