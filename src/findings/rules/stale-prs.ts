import type { Rule } from "../types.js";
import { ev, noSavings } from "../util.js";

export const stalePrs: Rule = {
  id: "stale-prs",
  title: "Open PRs behind base with no recent activity",
  description:
    "Open PRs idle for the stale threshold (14 days by default), with how far each head is behind its base. They pile up conflicts and re-run CI in bulk when someone finally rebases them.",
  detect(m) {
    const s = m.leadTime.stale;
    if (!s.count) return { status: "not-triggered", reason: `no open PR idle for ${s.thresholdDays}+ days` };
    return {
      status: "findings",
      findings: [{
        id: "stale-prs",
        ruleId: "stale-prs",
        title: `Close or rebase ${s.count} stale PRs`,
        kind: "fix",
        summary: `${s.count} open PRs have been idle for ${s.thresholdDays}+ days${s.behindBase ? `, ${s.behindBase} of them behind their base` : ""}. The oldest has been idle ${s.prs[0]?.idleDays} days.`,
        evidence: [
          ev("Stale PRs", s.count, "leadTime.stale.count"),
          ev("Behind base", s.behindBase, "leadTime.stale.behindBase"),
          ev("Open PR age, p50 (days)", m.leadTime.openPrAgeDays.p50, "leadTime.openPrAgeDays.p50"),
        ],
        table: {
          columns: ["PR", "Agent", "Age (days)", "Idle (days)", "Behind base (commits)", "Draft"],
          rows: s.prs.slice(0, 20).map((p) => [`#${p.number}`, p.agent, p.ageDays, p.idleDays, p.behindBy, p.draft ? "yes" : "no"]),
        },
        savings: noSavings("Hygiene: avoids bulk rebases and conflict churn later; no billed minutes in the window."),
        confidence: "high",
        fix: {
          summary: "Close what is abandoned; rebase or merge what is still wanted.",
          steps: [
            "Close PRs nobody plans to finish, with a comment saying how to reopen.",
            "For agent PRs, close and re-issue the task on the current base instead of rebasing a stale branch.",
            "If this recurs, a daily scheduled stale-PR workflow costs about a minute a day; weigh it against doing this by hand monthly.",
          ],
        },
      }],
    };
  },
};
