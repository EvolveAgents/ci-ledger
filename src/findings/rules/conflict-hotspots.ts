import type { Rule } from "../types.js";
import { ev, savings, withModel } from "../util.js";

export const conflictHotspots: Rule = {
  id: "conflict-hotspots",
  title: "Files behind merge-queue conflict ejections",
  description:
    "Lists the files most often changed by PRs ejected from the merge queue for a conflict. A file many PRs edit at once (a registry, a changelog, a lockfile) turns into a queue of rebases. Needs a merge queue.",
  detect(m) {
    const q = m.mergeQueue;
    if (!q.enabled) return { status: "skipped", reason: q.skippedReason ?? "no merge queue" };
    const ejections = q.exitsByReason.merge_conflict ?? 0;
    if (!ejections) return { status: "not-triggered", reason: "no conflict ejections in the window" };
    if (!q.conflictFiles.length) return { status: "not-triggered", reason: `${ejections} conflict ejections, but no file lists were collected` };
    const hot = q.conflictFiles.filter((f) => f.ejections >= 2).slice(0, 5);
    if (!hot.length) return { status: "not-triggered", reason: "no file appears in more than one conflict ejection" };
    const perHead = (m.ciPerPr.estimatedBillable.mean ?? 0) / Math.max(1, m.revisions.overall.headsPushed.mean ?? 1);
    const perEjection = perHead + (m.mergeGroups.meanBillablePerGroup ?? 0);
    const share = Math.min(1, hot[0]!.ejections / ejections);
    return {
      status: "findings",
      findings: [{
        id: "conflict-hotspots",
        ruleId: "conflict-hotspots",
        title: `Split or generate ${hot[0]!.path}`,
        kind: "fix",
        subject: hot[0]!.path,
        summary: `${ejections} queue entries were ejected for a merge conflict. ${hot.map((f) => `${f.path} (${f.ejections})`).join(", ")} appear in the most of them.`,
        evidence: [
          ev("Conflict ejections", ejections, "mergeQueue.exitsByReason.merge_conflict"),
          ev(`Ejected PRs touching ${hot[0]!.path}`, hot[0]!.ejections, "mergeQueue.conflictFiles[0].ejections"),
          ev("CI minutes per PR (est., mean)", m.ciPerPr.estimatedBillable.mean, "ciPerPr.estimatedBillable.mean"),
          ev("Heads pushed per merged PR (mean)", m.revisions.overall.headsPushed.mean, "revisions.overall.headsPushed.mean"),
          ev("Billable minutes per merge group (est.)", m.mergeGroups.meanBillablePerGroup, "mergeGroups.meanBillablePerGroup"),
        ],
        table: { columns: ["File", "Conflict ejections"], rows: q.conflictFiles.slice(0, 10).map((f) => [f.path, f.ejections]) },
        savings: savings(m, ejections * share * perEjection, "Conflict ejections involving the top file x (CI per PR / heads per PR for the catch-up push, plus one merge-group run to re-enter the queue)."),
        confidence: withModel(m, "low"),
        fix: {
          summary: `Stop PRs from editing ${hot[0]!.path} by hand at the same time.`,
          steps: [
            "Generate the file in the build (or in the queue) from per-feature sources instead of committing it.",
            "Or split it so each change touches its own file (one entry per file, then an index built at runtime).",
            "For append-only lists, a union merge driver avoids textual conflicts; review it, since it can't catch semantic clashes.",
          ],
          yaml: /lock|\.lock$|-lock\./i.test(hot[0]!.path) ? undefined : [" # .gitattributes", `+${hot[0]!.path} merge=union`].join("\n"),
        },
      }],
    };
  },
};
