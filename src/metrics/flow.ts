import { NO_AGENT } from "../config.js";
import { isBot, isHumanReviewer, sizeBucket, SIZE_BUCKETS } from "../model/classify.js";
import type { PullRequest, Run, TimelineEvent } from "../types.js";
import { distribution, groupBy, rate, round, sum } from "../util/stats.js";
import { hoursBetween, monthKey, weekKey } from "../util/time.js";
import { PR_EVENTS, billableOf, wallOf, type Context } from "./context.js";

const MANUAL_REASONS = new Set(["manual", "head_updated"]);

/** Normalizes merge-queue removal reasons (GraphQL gives strings such as MERGE_CONFLICT or FAILED_CHECKS). */
export function reasonKey(reason: string | null): string {
  if (!reason) return "unknown";
  const s = reason.toLowerCase();
  if (/conflict/.test(s)) return "merge_conflict";
  if (/fail|check|status|\bci\b/.test(s)) return "failed_checks";
  if (/time ?out|timed/.test(s)) return "timeout";
  if (/manual|dequeue|user|removed by/.test(s)) return "manual";
  if (/head|push|updated|changed/.test(s)) return "head_updated";
  return s.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "unknown";
}

interface Entry {
  pr: number;
  agent: string;
  addedAt: string;
  endedAt: string | null;
  outcome: "merged" | "removed" | "queued";
  reason: string | null;
}

/** Pairs each "added to merge queue" with the next removal or merge on the same PR. */
export function queueEntries(ctx: Context): Entry[] {
  const out: Entry[] = [];
  for (const pr of ctx.data.prs) {
    let open: Entry | null = null;
    for (const e of pr.timeline) {
      if (e.type === "queue_added") {
        if (open) out.push(open);
        open = { pr: pr.number, agent: ctx.agentOf.get(pr.number) ?? NO_AGENT, addedAt: e.at, endedAt: null, outcome: "queued", reason: null };
      } else if (open && (e.type === "queue_removed" || e.type === "merged")) {
        open.endedAt = e.at;
        open.outcome = e.type === "merged" ? "merged" : "removed";
        open.reason = e.type === "queue_removed" ? reasonKey(e.reason) : null;
        out.push(open);
        open = null;
      }
    }
    if (open) out.push(open);
  }
  const { since, until } = ctx.data.window;
  return out.filter((e) => e.addedAt.slice(0, 10) >= since && e.addedAt.slice(0, 10) <= until);
}

/**
 * Stats for a slice of entries (a week, an agent). Kick-out rate counts only entries whose outcome is
 * known (merged or removed). Entries per merged PR count all of that PR's entries in `all`, so a PR
 * ejected one week and merged the next is not "merged on the first try".
 */
function queueStats(entries: Entry[], all: Entry[] = entries) {
  const removed = entries.filter((e) => e.outcome === "removed");
  const kicked = removed.filter((e) => !MANUAL_REASONS.has(e.reason ?? ""));
  const merged = entries.filter((e) => e.outcome === "merged");
  const byPr = groupBy(all, (e) => e.pr);
  const perMergedPr = [...new Set(merged.map((e) => e.pr))].map((pr) => byPr.get(pr)?.length ?? 1);
  return {
    entries: entries.length,
    merged: merged.length,
    removed: removed.length,
    kickOuts: kicked.length,
    kickOutRate: rate(kicked.length, merged.length + removed.length),
    mergedPrs: perMergedPr.length,
    entriesPerMergedPr: distribution(perMergedPr),
    mergedFirstTry: perMergedPr.filter((n) => n === 1).length,
    mergedFirstTryRate: rate(perMergedPr.filter((n) => n === 1).length, perMergedPr.length),
  };
}

export function mergeQueueSection(ctx: Context) {
  const entries = queueEntries(ctx);
  const groupRuns = ctx.data.runs.filter((r) => r.event === "merge_group");
  const evidence = [
    ...(ctx.data.setup.mergeQueue ? ["repository rules or GraphQL report a merge queue on the default branch"] : []),
    ...(entries.length ? [`${entries.length} merge-queue entries in PR timelines`] : []),
    ...(groupRuns.length ? [`${groupRuns.length} merge_group workflow runs`] : []),
  ];
  const enabled = evidence.length > 0;
  const conflictFiles = new Map<string, number>();
  for (const e of entries.filter((x) => x.reason === "merge_conflict")) {
    for (const f of ctx.prs.get(e.pr)?.files ?? []) conflictFiles.set(f, (conflictFiles.get(f) ?? 0) + 1);
  }
  const conflictPrs = new Set(entries.filter((x) => x.reason === "merge_conflict").map((x) => x.pr));
  return {
    enabled,
    evidence,
    skippedReason: enabled
      ? null
      : "No merge queue found on the default branch. Merge queues exist only on public repositories and on private repositories in organizations on GitHub Enterprise Cloud.",
    ...queueStats(entries),
    stillQueued: entries.filter((e) => e.outcome === "queued").length,
    exitsByReason: Object.fromEntries(
      [...groupBy(entries.filter((e) => e.outcome === "removed"), (e) => e.reason ?? "unknown")].map(([k, l]) => [k, l.length]).sort(),
    ),
    minutesInQueue: {
      merged: distribution(entries.filter((e) => e.outcome === "merged").map((e) => (hoursBetween(e.addedAt, e.endedAt) ?? 0) * 60), 1),
      ejected: distribution(entries.filter((e) => e.outcome === "removed").map((e) => (hoursBetween(e.addedAt, e.endedAt) ?? 0) * 60), 1),
    },
    weekly: [...groupBy(entries, (e) => weekKey(e.addedAt))].sort(([a], [b]) => a.localeCompare(b)).map(([week, l]) => ({ week, ...queueStats(l, entries) })),
    byAgent: [...groupBy(entries, (e) => e.agent)].sort(([a], [b]) => a.localeCompare(b)).map(([agent, l]) => ({ agent, ...queueStats(l, entries) })),
    conflictFiles: [...conflictFiles].map(([path, ejections]) => ({ path, ejections })).sort((a, b) => b.ejections - a.ejections || a.path.localeCompare(b.path)).slice(0, 20),
    conflictPrsWithFiles: [...conflictPrs].filter((n) => ctx.prs.get(n)?.files).length,
    conflictPrs: conflictPrs.size,
  };
}

const runFailed = (r: Run) => r.conclusion === "failure" || r.conclusion === "timed_out";

export function mergeGroupsSection(ctx: Context) {
  const groups = [...groupBy(ctx.data.runs.filter((r) => r.event === "merge_group"), (r) => r.headBranch ?? r.headSha).values()];
  const failedGroups = groups.filter((g) => g.some(runFailed));
  const combos = new Map<string, number>();
  for (const g of failedGroups) {
    const names = g.filter(runFailed).flatMap((r) => {
      const jobs = ctx.data.jobs[String(r.id)]?.filter((j) => j.conclusion === "failure").map((j) => `${r.name} / ${j.name}`);
      return jobs?.length ? jobs : [r.name];
    });
    const key = [...new Set(names)].sort().join(" + ");
    combos.set(key, (combos.get(key) ?? 0) + 1);
  }
  return {
    groups: groups.length,
    failed: failedGroups.length,
    failureRate: rate(failedGroups.length, groups.length),
    failedCheckCombinations: [...combos].map(([checks, count]) => ({ checks, groups: count })).sort((a, b) => b.groups - a.groups || a.checks.localeCompare(b.checks)),
    failedGroupMinutes: {
      estimatedBillable: round(sum(failedGroups.map((g) => billableOf(ctx, g))), 1),
      wall: round(sum(failedGroups.map((g) => wallOf(ctx, g))), 1),
    },
    meanBillablePerGroup: groups.length ? round(sum(groups.map((g) => billableOf(ctx, g))) / groups.length, 2) : null,
    workflowsPerGroup: distribution(groups.map((g) => new Set(g.map((r) => r.path)).size)),
  };
}

function catchUpMerge(e: TimelineEvent, base: string): boolean {
  if (e.type !== "commit") return false;
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Merge (branch|remote-tracking branch) '(origin/)?${b}'|^Merge (origin/)?${b} into `, "i").test(e.headline);
}

export interface PrRevisions {
  number: number;
  agent: string;
  bucket: string;
  month: string;
  headsPushed: number;
  commits: number;
  forcePushes: number;
  catchUpMerges: number;
  botReviews: number;
  humanReviews: number;
  changesRequested: number;
  dismissals: number;
  estimatedBillable: number;
}

export function revisionsOf(ctx: Context, pr: PullRequest): PrRevisions {
  const runs = ctx.runsByPr.get(pr.number) ?? [];
  const t = pr.timeline;
  const commits = t.filter((e) => e.type === "commit");
  const heads = new Set(runs.filter((r) => PR_EVENTS.has(r.event)).map((r) => r.headSha));
  const reviews = t.filter((e): e is Extract<TimelineEvent, { type: "review" }> => e.type === "review");
  return {
    number: pr.number,
    agent: ctx.agentOf.get(pr.number) ?? NO_AGENT,
    bucket: sizeBucket(pr.additions + pr.deletions),
    month: monthKey(pr.mergedAt ?? pr.createdAt),
    headsPushed: heads.size || Math.max(1, new Set(commits.map((c) => (c.type === "commit" ? c.sha : ""))).size),
    commits: commits.length,
    forcePushes: t.filter((e) => e.type === "force_pushed").length,
    catchUpMerges: t.filter((e) => catchUpMerge(e, pr.baseRef)).length,
    botReviews: reviews.filter((r) => isBot(r.author, r.authorIsBot, ctx.config)).length,
    humanReviews: reviews.filter((r) => isHumanReviewer(r.author, r.authorIsBot, ctx.config)).length,
    changesRequested: reviews.filter((r) => r.state === "CHANGES_REQUESTED" && isHumanReviewer(r.author, r.authorIsBot, ctx.config)).length,
    dismissals: t.filter((e) => e.type === "review_dismissed").length,
    estimatedBillable: round(billableOf(ctx, runs), 1),
  };
}

function summarize(rows: PrRevisions[]) {
  const d = (k: keyof PrRevisions) => distribution(rows.map((r) => r[k] as number));
  return {
    prs: rows.length,
    headsPushed: d("headsPushed"),
    commits: d("commits"),
    forcePushes: d("forcePushes"),
    catchUpMerges: d("catchUpMerges"),
    botReviews: d("botReviews"),
    humanReviews: d("humanReviews"),
    changesRequested: d("changesRequested"),
    dismissals: sum(rows.map((r) => r.dismissals)),
    estimatedBillablePerPr: distribution(rows.map((r) => r.estimatedBillable), 1),
  };
}

export function mergedInWindow(ctx: Context): PullRequest[] {
  const { since, until } = ctx.data.window;
  return ctx.data.prs.filter((p) => p.mergedAt && p.mergedAt.slice(0, 10) >= since && p.mergedAt.slice(0, 10) <= until);
}

export function revisionsSection(ctx: Context) {
  const rows = mergedInWindow(ctx).map((pr) => revisionsOf(ctx, pr));
  const by = (key: (r: PrRevisions) => string, order?: string[]) =>
    Object.fromEntries(
      [...groupBy(rows, key)].sort(([a], [b]) => (order ? order.indexOf(a) - order.indexOf(b) : a.localeCompare(b))).map(([k, l]) => [k, summarize(l)]),
    );
  return { overall: summarize(rows), byAgent: by((r) => r.agent), bySize: by((r) => r.bucket, SIZE_BUCKETS), byMonth: by((r) => r.month) };
}

export function leadTimeSection(ctx: Context) {
  const merged = mergedInWindow(ctx);
  const firstQueue = (p: PullRequest) => p.timeline.find((e) => e.type === "queue_added")?.at ?? null;
  const lastApproval = (p: PullRequest) =>
    [...p.timeline].reverse().find((e) => e.type === "review" && e.state === "APPROVED" && e.at <= (p.mergedAt ?? "") && isHumanReviewer(e.author, e.authorIsBot, ctx.config))?.at ?? null;
  const hours = (vals: Array<number | null>) => distribution(vals.filter((v): v is number => v !== null), 1);
  const end = new Date(Math.min(ctx.now.getTime(), Date.parse(`${ctx.data.window.until}T23:59:59Z`)));
  const asOf = end.toISOString();
  // Open as of the window end (not as of collection), with idle time from the last activity before it.
  const openAt = (p: PullRequest) => p.createdAt <= asOf && !(p.closedAt && p.closedAt <= asOf) && !(p.mergedAt && p.mergedAt <= asOf);
  const lastActivity = (p: PullRequest) =>
    [p.createdAt, ...(p.updatedAt <= asOf ? [p.updatedAt] : []), ...p.timeline.map((e) => e.at).filter((t) => t <= asOf)].reduce((a, b) => (b > a ? b : a));
  const open = ctx.data.prs.filter(openAt);
  const days = (a: string) => (hoursBetween(a, asOf) ?? 0) / 24;
  const stale = open
    .map((p) => ({
      number: p.number,
      agent: ctx.agentOf.get(p.number) ?? NO_AGENT,
      draft: p.draft,
      ageDays: round(days(p.createdAt), 1),
      idleDays: round(days(lastActivity(p)), 1),
      // Behind-base counts are measured at collection time, so only for PRs still open then.
      behindBy: p.state === "open" ? (p.behindBy ?? null) : null,
    }))
    .filter((p) => p.idleDays >= ctx.config.staleDays)
    .sort((a, b) => b.idleDays - a.idleDays || a.number - b.number);
  return {
    unit: "hours",
    asOf,
    createdToMerged: hours(merged.map((p) => hoursBetween(p.createdAt, p.mergedAt))),
    createdToFirstQueue: hours(merged.map((p) => hoursBetween(p.createdAt, firstQueue(p)))),
    firstQueueToMerged: hours(merged.map((p) => hoursBetween(firstQueue(p), p.mergedAt))),
    lastHumanApprovalToMerged: hours(merged.map((p) => hoursBetween(lastApproval(p), p.mergedAt))),
    createdToMergedByAgent: Object.fromEntries(
      [...groupBy(merged, (p) => ctx.agentOf.get(p.number) ?? NO_AGENT)].sort(([a], [b]) => a.localeCompare(b)).map(([a, l]) => [a, hours(l.map((p) => hoursBetween(p.createdAt, p.mergedAt)))]),
    ),
    openPrAgeDays: distribution(open.map((p) => days(p.createdAt)), 1),
    stale: { thresholdDays: ctx.config.staleDays, count: stale.length, behindBase: stale.filter((s) => (s.behindBy ?? 0) > 0).length, prs: stale.slice(0, 50) },
  };
}

export function agentsSection(ctx: Context) {
  const { since, until } = ctx.data.window;
  const inWindow = (t: string | null) => !!t && t.slice(0, 10) >= since && t.slice(0, 10) <= until;
  const totalBillable = sum([...ctx.perRunBillable.values()]);
  const merged = new Set(mergedInWindow(ctx).map((p) => p.number));
  const entries = queueEntries(ctx);
  return [...groupBy(ctx.data.prs, (p) => ctx.agentOf.get(p.number) ?? NO_AGENT)].sort(([a], [b]) => a.localeCompare(b)).map(([agent, prs]) => {
    const runs = prs.flatMap((p) => ctx.runsByPr.get(p.number) ?? []);
    const rows = prs.filter((p) => merged.has(p.number)).map((p) => revisionsOf(ctx, p));
    const billable = billableOf(ctx, runs);
    const q = queueStats(entries.filter((e) => e.agent === agent));
    return {
      agent,
      prsOpened: prs.filter((p) => inWindow(p.createdAt)).length,
      prsMerged: rows.length,
      runs: runs.length,
      wallMinutes: round(wallOf(ctx, runs), 1),
      estimatedBillable: round(billable, 1),
      billableShare: rate(billable, totalBillable),
      headsPerMergedPr: rows.length ? round(sum(rows.map((r) => r.headsPushed)) / rows.length, 2) : null,
      forcePushesPerMergedPr: rows.length ? round(sum(rows.map((r) => r.forcePushes)) / rows.length, 2) : null,
      changesRequestedPerMergedPr: rows.length ? round(sum(rows.map((r) => r.changesRequested)) / rows.length, 2) : null,
      queueKickOutRate: q.kickOutRate,
    };
  });
}
