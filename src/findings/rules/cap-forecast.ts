import type { Rule } from "../types.js";
import { round } from "../../util/stats.js";
import { addDays } from "../../util/time.js";
import { ev, noSavings, withModel } from "../util.js";

function daysInMonth(month: string): number {
  const [y, mo] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, mo!, 0)).getUTCDate();
}

export const capForecast: Rule = {
  id: "cap-forecast",
  title: "Month-end forecast against included minutes and the spending limit",
  description:
    "Projects month-to-date Actions minutes to the end of the month and gives the date they cross the plan's included minutes and the spending limit (set both in ci-ledger.config.json under billing).",
  detect(m, config) {
    if (!m.model.privateRepo) return { status: "not-triggered", reason: "public repository: standard GitHub-hosted runner minutes are free" };
    const included = config.billing.includedMinutes;
    const mtd = m.billing.monthToDate;
    const month = m.window.until.slice(0, 7);
    const rollup = m.rollups.monthly.find((r) => r.period === month);
    const used = mtd ? mtd.orgMinutes : rollup?.estimatedBillable ?? 0;
    const daysElapsed = mtd ? mtd.daysElapsed : Number(m.window.until.slice(8, 10));
    const total = daysInMonth(month);
    const perDay = used / Math.max(1, daysElapsed);
    const projected = round(perDay * total, 0);
    const rate = m.model.rates[0]?.perMinute ?? 0;
    const limitMinutes = config.billing.spendingLimitUsd !== null && rate > 0 ? config.billing.spendingLimitUsd / rate : null;
    const cap = included === null ? null : included + (limitMinutes ?? 0);
    const crossDay = (threshold: number) => (perDay > 0 && threshold > used ? Math.ceil((threshold - used) / perDay) : threshold <= used ? 0 : null);
    const scope = mtd ? "org-wide billing usage" : "this repo's estimate only (billing unavailable)";
    if (included === null) {
      return { status: "not-triggered", reason: `set billing.includedMinutes in ci-ledger.config.json to forecast a cap date; projected month-end use is ${projected} minutes (${scope})` };
    }
    if (cap !== null && projected < cap && projected < included) {
      return { status: "not-triggered", reason: `projected ${projected} of ${included} included minutes by month end (${scope})` };
    }
    const inc = crossDay(included);
    const lim = cap !== null && limitMinutes !== null ? crossDay(cap) : null;
    const dateOf = (d: number | null) => (d === null ? null : addDays(mtd?.throughDate ?? m.window.until, d));
    const incDate = dateOf(inc);
    const limDate = dateOf(lim);
    return {
      status: "findings",
      findings: [{
        id: "cap-forecast",
        ruleId: "cap-forecast",
        title: limDate ? `Actions spending limit reached around ${limDate}` : `Included minutes run out around ${incDate}`,
        kind: "report",
        summary: `${round(used, 0)} minutes used through day ${daysElapsed} (${scope}) projects to ${projected} by month end, against ${included} included minutes${limitMinutes !== null ? ` and a $${config.billing.spendingLimitUsd} limit` : ""}.`,
        evidence: [
          ev("Month-to-date minutes", round(used, 0), mtd ? "billing.monthToDate.orgMinutes" : `rollups.monthly[${m.rollups.monthly.indexOf(rollup!)}].estimatedBillable`),
          ev("Days elapsed", daysElapsed, mtd ? "billing.monthToDate.daysElapsed" : "window.until"),
          ev("Included minutes (config)", included, "config.billing.includedMinutes"),
          ev("Spending limit USD (config)", config.billing.spendingLimitUsd, "config.billing.spendingLimitUsd"),
        ],
        savings: noSavings("A forecast; the fixes above reduce the burn rate."),
        confidence: withModel(m, mtd ? "medium" : "low"),
        fix: {
          summary: "Cut minutes with the fixes above before the cap date, or raise the spending limit so required checks keep running.",
          steps: [
            ...(incDate ? [`Included minutes run out around ${incDate}.`] : []),
            ...(limDate ? [`The spending limit is reached around ${limDate}; after that, jobs on GitHub-hosted runners stop until the next cycle.`] : []),
            "Re-run the audit mid-month to check the projection.",
          ],
        },
      }],
    };
  },
};
