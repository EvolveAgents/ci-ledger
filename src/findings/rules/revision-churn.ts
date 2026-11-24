import { SIZE_BUCKETS } from "../../model/classify.js";
import type { Rule } from "../types.js";
import { ev, savings, withModel } from "../util.js";

export const revisionChurn: Rule = {
  id: "revision-churn",
  title: "Pushes per PR climbing with PR size",
  description:
    "Every push re-runs the PR's CI. Compares heads pushed per merged PR across size buckets; when large PRs take far more rounds than small ones, a size ceiling cuts pushes and review rounds.",
  detect(m) {
    const by = m.revisions.bySize;
    const base = by["<100"]?.prs ? by["<100"] : by["100-299"];
    const baseHeads = base?.headsPushed.mean ?? null;
    if (!base || baseHeads === null || base.prs < 3) return { status: "not-triggered", reason: "too few small merged PRs for a baseline" };
    const big = SIZE_BUCKETS.filter((b) => (by[b]?.prs ?? 0) >= 3 && (by[b]!.headsPushed.mean ?? 0) >= 1.5 * baseHeads && b !== "<100" && b !== "100-299");
    if (!big.length) return { status: "not-triggered", reason: "large PRs take about as many pushes as small ones" };
    const ceiling = big[0] === "1200+" ? 1200 : 300;
    const perHead = (m.ciPerPr.estimatedBillable.mean ?? 0) / Math.max(1, m.revisions.overall.headsPushed.mean ?? 1);
    const extraHeads = big.reduce((s, b) => s + by[b]!.prs * Math.max(0, (by[b]!.headsPushed.mean ?? 0) - baseHeads), 0);
    return {
      status: "findings",
      findings: [{
        id: "revision-churn",
        ruleId: "revision-churn",
        title: `Keep PRs under ${ceiling} changed lines`,
        kind: "fix",
        summary: `Merged PRs of ${big.join(" and ")} lines took ${big.map((b) => by[b]!.headsPushed.mean).join(" and ")} pushes on average, against ${baseHeads} for small PRs; that is ~${Math.round(extraHeads)} extra CI rounds in the window.`,
        evidence: [
          ...big.map((b) => ev(`Heads per merged PR, ${b} lines`, by[b]!.headsPushed.mean, `revisions.bySize["${b}"].headsPushed.mean`)),
          ev("Heads per merged PR, small PRs", baseHeads, `revisions.bySize["${base === by["<100"] ? "<100" : "100-299"}"].headsPushed.mean`),
          ev("Human change requests per merged PR", m.revisions.overall.changesRequested.mean, "revisions.overall.changesRequested.mean"),
        ],
        table: {
          columns: ["Size (lines)", "Merged PRs", "Heads pushed (mean)", "Force pushes (mean)", "Changes requested (mean)"],
          rows: SIZE_BUCKETS.filter((b) => by[b]).map((b) => [b, by[b]!.prs, by[b]!.headsPushed.mean, by[b]!.forcePushes.mean, by[b]!.changesRequested.mean]),
        },
        savings: savings(m, extraHeads * perHead * 0.5, "Half of the extra pushes large PRs take over small ones, at the mean CI cost per push; splitting adds PRs, so only half is counted."),
        confidence: withModel(m, "low"),
        fix: {
          summary: `Fail or label PRs over ${ceiling} changed lines, and ask agents and authors to split them.`,
          steps: [
            "Add the size check as a step of an existing PR job, not a new job (a new job bills its own minute).",
            "Tell coding agents the ceiling in their instructions (AGENTS.md, CLAUDE.md or the task prompt).",
            "Exempt generated files and lockfiles if they dominate the count.",
          ],
          yaml: [
            "       steps:",
            "+        - name: PR size ceiling",
            "+          if: github.event_name == 'pull_request'",
            "+          run: |",
            "+            lines=$(( ${{ github.event.pull_request.additions }} + ${{ github.event.pull_request.deletions }} ))",
            `+            if [ "$lines" -gt ${ceiling} ]; then echo "::error::$lines changed lines; split below ${ceiling}"; exit 1; fi`,
          ].join("\n"),
        },
      }],
    };
  },
};
