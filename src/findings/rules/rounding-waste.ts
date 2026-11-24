import type { Rule } from "../types.js";
import { ev, savings, slug, withModel } from "../util.js";

export const roundingWaste: Rule = {
  id: "rounding-waste",
  title: "Short jobs billed as whole minutes",
  description:
    "GitHub bills every job rounded up to a whole minute, so a 20-second job costs a full minute. Flags workflows whose runs have short jobs (under 60 s by default) next to other jobs, and computes, from the sampled runs, what folding them into one job would save.",
  detect(m) {
    const s = m.billable.shortJobs;
    const rows = s.byWorkflow.filter((w) => w.estimatedFoldSavingsMinutes >= 5);
    if (!rows.length) {
      return {
        status: "not-triggered",
        reason: `${s.shortJobs} of ${s.sampledJobs} sampled jobs ran under ${s.thresholdSeconds}s, but folding them into other jobs of the same run saves under 5 minutes per workflow (single-job runs have nothing to fold into)`,
      };
    }
    return {
      status: "findings",
      findings: rows.map((w) => {
        const i = s.byWorkflow.indexOf(w);
        const [first, second] = w.jobs;
        const parent = m.billable.byJob.filter((j) => j.workflow === w.workflow && !w.jobs.includes(j.job)).sort((a, b) => b.meanSeconds - a.meanSeconds)[0]?.job ?? "build";
        return {
          id: `rounding-waste:${slug(w.workflow)}`,
          ruleId: "rounding-waste",
          title: `Fold short jobs in "${w.workflow}" into one job`,
          kind: "fix" as const,
          subject: w.workflow,
          summary: `About ${w.estimatedJobs} jobs in "${w.workflow}" (${w.jobs.join(", ")}) ran under ${s.thresholdSeconds}s in the window. Each bills a whole minute plus its own setup; folding them into another job of the same run saves ~${w.estimatedFoldSavingsMinutes} minutes.`,
          evidence: [
            ev("Short jobs (est.)", w.estimatedJobs, `billable.shortJobs.byWorkflow[${i}].estimatedJobs`),
            ev("Rounding waste of those jobs, window (min)", w.estimatedWasteMinutes, `billable.shortJobs.byWorkflow[${i}].estimatedWasteMinutes`),
            ev("Saved by folding, window (min)", w.estimatedFoldSavingsMinutes, `billable.shortJobs.byWorkflow[${i}].estimatedFoldSavingsMinutes`),
            ev("Short share of all sampled jobs", s.shortShare, "billable.shortJobs.shortShare"),
          ],
          savings: savings(m, w.estimatedFoldSavingsMinutes, "Per sampled run: billed minutes of the short jobs and their new parent job, minus one round-up of the combined time without the folded jobs' setup steps; scaled to every run."),
          confidence: withModel(m, "medium"),
          fix: {
            summary: `Run ${w.jobs.join(", ")} as steps of an existing job instead of separate jobs.`,
            steps: [
              `Move the steps of ${w.jobs.join(", ")} into the "${parent}" job (or one combined "checks" job).`,
              "Keep a separate job only where it needs a different runner, permissions or a matrix.",
              "If the checks must report separately, keep them as named steps; required checks can point at the combined job.",
            ],
            yaml: [
              " jobs:",
              `-  ${first}:`,
              "-    runs-on: ubuntu-latest",
              "-    steps:",
              "-      - uses: actions/checkout@v4",
              `-      - run: <${first} command>`,
              ...(second ? [`-  ${second}:`, "-    runs-on: ubuntu-latest", "-    steps:", "-      - uses: actions/checkout@v4", `-      - run: <${second} command>`] : []),
              `   ${parent}:`,
              "     runs-on: ubuntu-latest",
              "     steps:",
              "       - uses: actions/checkout@v4",
              `+      - run: <${first} command>`,
              ...(second ? [`+      - run: <${second} command>`] : []),
              `       - run: <${parent} command>`,
            ].join("\n"),
          },
        };
      }),
    };
  },
};
