import { NO_AGENT } from "../../config.js";
import type { Rule } from "../types.js";
import { ev, noSavings, pct } from "../util.js";

export const agentReport: Rule = {
  id: "agent-report",
  title: "Coding agents: PRs, CI minutes and rework",
  description:
    "A one-time report from generic signals: PRs each agent opened and merged, the CI minutes their pushes caused, and rework rounds (pushes, force pushes, change requests). Agents come from branch prefixes or PR authors in config.",
  detect(m) {
    const agents = m.agents.filter((a) => a.agent !== NO_AGENT);
    if (!agents.length) return { status: "not-triggered", reason: "no PR matched an agent branch prefix or author" };
    const top = [...agents].sort((a, b) => b.estimatedBillable - a.estimatedBillable)[0]!;
    const ti = m.agents.indexOf(top);
    const agentShare = agents.reduce((s, a) => s + (a.billableShare ?? 0), 0);
    return {
      status: "findings",
      findings: [{
        id: "agent-report",
        ruleId: "agent-report",
        title: `Agents caused ${pct(agentShare)} of estimated CI minutes`,
        kind: "report",
        summary: `${agents.length} agents opened ${agents.reduce((s, a) => s + a.prsOpened, 0)} PRs in the window. ${top.agent} caused the most CI (~${top.estimatedBillable} billable minutes, ${pct(top.billableShare)}), at ${top.headsPerMergedPr ?? "n/a"} pushes per merged PR.`,
        evidence: [
          ev(`${top.agent}: estimated billable minutes`, top.estimatedBillable, `agents[${ti}].estimatedBillable`),
          ev(`${top.agent}: share of estimated minutes`, top.billableShare, `agents[${ti}].billableShare`),
          ev(`${top.agent}: pushes per merged PR`, top.headsPerMergedPr, `agents[${ti}].headsPerMergedPr`),
        ],
        table: {
          columns: ["Agent", "PRs opened", "Merged", "CI runs", "Billable min (est.)", "Share", "Pushes / merged PR", "Force pushes / PR", "Changes requested / PR", "Queue kick-out rate"],
          rows: m.agents.map((a) => [a.agent, a.prsOpened, a.prsMerged, a.runs, a.estimatedBillable, pct(a.billableShare), a.headsPerMergedPr, a.forcePushesPerMergedPr, a.changesRequestedPerMergedPr, pct(a.queueKickOutRate)]),
        },
        savings: noSavings("A report; see revision-churn and the queue fixes for what to change."),
        confidence: m.model.confidence === "low" ? "low" : "medium",
        fix: {
          summary: "Give agents the cheapest path to a green PR on the first push.",
          steps: [
            "Have agents run the same lint and test commands locally before pushing (put them in AGENTS.md / CLAUDE.md).",
            "Ask for one push per review round instead of many small pushes; each push re-runs every PR workflow.",
            "Compare agents on pushes per merged PR and change requests, not only PR counts.",
          ],
        },
      }],
    };
  },
};
