import { jobMatchesCheck } from "../model/classify.js";
import { jobMinutes, repoMatches } from "../model/cost.js";
import { stratumKey } from "../model/strata.js";
import type { Run } from "../types.js";
import { countBy, distribution, groupBy, rate, round, sum, type Distribution } from "../util/stats.js";
import { dayKey, minutesBetween, monthKey, weekKey } from "../util/time.js";
import { PR_EVENTS, billableOf, wallOf, type Context } from "./context.js";

const failed = (r: Run) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "startup_failure";
export const TEST_COMMAND =
  /\b(npm (run )?test|npm t\b|pnpm (run )?test|yarn (run )?test|bun test|npx (jest|vitest|mocha)|jest|vitest|pytest|python -m pytest|tox|go test|cargo (nextest|test)|mvn (-\S+ )*(test|verify)|gradlew? (\S+ )*test|rspec|bundle exec rake( test)?|phpunit|dotnet test|ctest|mix test|swift test)\b/i;

export function windowSection(ctx: Context) {
  const { data } = ctx;
  const since = `${data.window.since}T00:00:00Z`;
  const until = `${data.window.until}T23:59:59Z`;
  const inWindow = (t: string | null) => t !== null && t >= since && t <= until;
  return {
    since: data.window.since,
    until: data.window.until,
    days: Math.round((Date.parse(until) - Date.parse(since)) / 86_400_000),
    firstRunAt: data.runs[0]?.createdAt ?? null,
    lastRunAt: data.runs[data.runs.length - 1]?.createdAt ?? null,
    runs: data.runs.length,
    completedRuns: ctx.wall.size,
    prsInScope: data.prs.length,
    prsCreated: data.prs.filter((p) => inWindow(p.createdAt)).length,
    prsMerged: data.prs.filter((p) => inWindow(p.mergedAt)).length,
    openPrs: data.prs.filter((p) => p.state === "open").length,
  };
}

/** Runs superseded by a newer run of the same workflow for the same PR or branch while still running. */
function superseded(ctx: Context, runs: Run[]) {
  const key = (r: Run) => `${r.event}|${ctx.link.prByRun.get(r.id) ?? r.headBranch}`;
  let count = 0;
  let minutes = 0;
  for (const list of groupBy(runs.filter((r) => PR_EVENTS.has(r.event)), key).values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 0; i + 1 < list.length; i++) {
      const older = list[i]!;
      const newer = list[i + 1]!;
      if (older.headSha === newer.headSha || older.conclusion === "cancelled") continue;
      const overlap = minutesBetween(newer.createdAt, older.updatedAt);
      if (overlap !== null && overlap > 0) {
        count++;
        minutes += overlap;
      }
    }
  }
  return { runs: count, wallMinutes: round(minutes, 1) };
}

/** First-attempt runs of a PR workflow on a head SHA it already ran on (labels, edits, re-opens). */
function sameHeadRetriggers(runs: Run[]) {
  const seen = new Set<string>();
  const repeats: Run[] = [];
  for (const r of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!PR_EVENTS.has(r.event) && r.event !== "workflow_run") continue;
    const k = `${r.event}|${r.headSha}`;
    if (seen.has(k) && r.runAttempt === 1) repeats.push(r);
    seen.add(k);
  }
  return repeats;
}

export function workflowsSection(ctx: Context) {
  const rows = [];
  for (const [path, runs] of groupBy(ctx.data.runs, (r) => r.path)) {
    const walls = runs.map((r) => ctx.wall.get(r.id)).filter((m): m is number => m !== undefined);
    const repeats = sameHeadRetriggers(runs);
    const estimated = runs.filter((r) => ctx.perRunBillable.has(r.id));
    rows.push({
      name: runs[0]!.name,
      path,
      group: ctx.groups.get(path) ?? "other",
      runs: runs.length,
      wallMinutes: round(sum(walls), 1),
      failed: runs.filter(failed).length,
      cancelled: runs.filter((r) => r.conclusion === "cancelled").length,
      skipped: runs.filter((r) => r.conclusion === "skipped").length,
      reruns: sum(runs.map((r) => Math.max(0, r.runAttempt - 1))),
      failureRate: rate(runs.filter(failed).length, runs.filter((r) => r.status === "completed").length),
      p50: distribution(walls).p50,
      p90: distribution(walls).p90,
      events: countBy(runs, (r) => r.event),
      linkedRuns: runs.filter((r) => ctx.link.prByRun.has(r.id)).length,
      estimatedBillable: round(billableOf(ctx, estimated), 1),
      meanBillable: estimated.length ? round(billableOf(ctx, estimated) / estimated.length, 2) : null,
      sameHeadRetriggers: { runs: repeats.length, estimatedBillable: round(billableOf(ctx, repeats), 1) },
      superseded: superseded(ctx, runs),
      failedRunMinutesP50: distribution(runs.filter(failed).map((r) => ctx.wall.get(r.id) ?? 0)).p50,
    });
  }
  return rows.sort((a, b) => b.estimatedBillable - a.estimatedBillable || b.runs - a.runs);
}

export function workflowFilesSection(ctx: Context) {
  return [...ctx.workflowInfo.values()].map((info) => {
    const prTriggers = ["pull_request", "pull_request_target"].filter((e) => e in info.triggers);
    const helperTypes = prTriggers.flatMap((e) => (info.triggers[e] ?? []).filter((t) => ["labeled", "unlabeled", "edited", "assigned", "review_requested"].includes(t)));
    const c = info.concurrency;
    return {
      path: info.path,
      name: info.name,
      group: ctx.groups.get(info.path) ?? "other",
      triggers: info.triggers,
      prTriggered: prTriggers.length > 0,
      helperTriggers: [...new Set([...helperTypes, ...(["workflow_run", "issue_comment"].filter((e) => e in info.triggers))])],
      concurrency: c,
      cancelsSuperseded: c !== null && (c.cancelInProgress === true || typeof c.cancelInProgress === "string"),
      jobs: info.jobs.map((j) => ({ id: j.id, name: j.name, runsOn: j.runsOn, steps: j.steps, testCommands: j.commands.filter((cmd) => TEST_COMMAND.test(cmd)) })),
      ...(info.parseError ? { parseError: info.parseError } : {}),
    };
  });
}

export function requiredChecksSection(ctx: Context) {
  const { setup } = ctx.data;
  const sampled = Object.values(ctx.data.jobs).flat();
  const nameOfRun = new Map(ctx.data.runs.map((r) => [r.id, r.name]));
  return {
    source: setup.requiredChecksSource,
    contexts: setup.requiredChecks,
    basis: "sampled jobs",
    checks: setup.requiredChecks.map((context) => {
      const jobs = sampled.filter((j) => jobMatchesCheck(j.name, context, nameOfRun.get(j.runId)));
      const done = jobs.filter((j) => j.status === "completed" && j.conclusion !== "skipped");
      return {
        context,
        jobsSampled: done.length,
        failed: done.filter((j) => j.conclusion === "failure").length,
        cancelled: done.filter((j) => j.conclusion === "cancelled").length,
        failureRate: rate(done.filter((j) => j.conclusion === "failure").length, done.length),
        cancelRate: rate(done.filter((j) => j.conclusion === "cancelled").length, done.length),
      };
    }),
  };
}

export function fanOutSection(ctx: Context) {
  const prRuns = ctx.data.runs.filter((r) => ctx.link.prByRun.has(r.id) && r.event !== "merge_group");
  const perHead = [...groupBy(prRuns, (r) => r.headSha).values()].map((l) => l.length);
  return { heads: perHead.length, runsPerHead: distribution(perHead) };
}

export function ciPerPrSection(ctx: Context) {
  const lists = [...ctx.runsByPr.values()];
  return {
    prsWithRuns: lists.length,
    linkedRuns: ctx.link.prByRun.size,
    ambiguousRuns: ctx.link.ambiguous,
    unlinkedRuns: ctx.link.unlinked,
    linkMethods: ctx.link.methods,
    runs: distribution(lists.map((l) => l.length)),
    wallMinutes: distribution(lists.map((l) => wallOf(ctx, l)), 1),
    estimatedBillable: distribution(lists.map((l) => billableOf(ctx, l)), 1),
  };
}

export function rollupsSection(ctx: Context) {
  const build = (keyOf: (iso: string) => string) => {
    const out = new Map<string, { period: string; runs: number; failedRuns: number; wallMinutes: number; estimatedBillable: number; prsCreated: number; prsMerged: number }>();
    const row = (k: string) => {
      if (!out.has(k)) out.set(k, { period: k, runs: 0, failedRuns: 0, wallMinutes: 0, estimatedBillable: 0, prsCreated: 0, prsMerged: 0 });
      return out.get(k)!;
    };
    for (const r of ctx.data.runs) {
      const x = row(keyOf(r.createdAt));
      x.runs++;
      if (failed(r)) x.failedRuns++;
      x.wallMinutes += ctx.wall.get(r.id) ?? 0;
      x.estimatedBillable += ctx.perRunBillable.get(r.id) ?? 0;
    }
    const { since, until } = ctx.data.window;
    for (const p of ctx.data.prs) {
      if (p.createdAt.slice(0, 10) >= since && p.createdAt.slice(0, 10) <= until) row(keyOf(p.createdAt)).prsCreated++;
      if (p.mergedAt && p.mergedAt.slice(0, 10) >= since && p.mergedAt.slice(0, 10) <= until) row(keyOf(p.mergedAt)).prsMerged++;
    }
    return [...out.values()]
      .map((x) => ({ ...x, wallMinutes: round(x.wallMinutes, 1), estimatedBillable: round(x.estimatedBillable, 1) }))
      .sort((a, b) => a.period.localeCompare(b.period));
  };
  return { weekly: build(weekKey), monthly: build(monthKey) };
}

export function billingSection(ctx: Context) {
  const { billing, repo, window } = ctx.data;
  if (billing.status !== "ok") return { available: false, reason: billing.reason ?? null, byMonth: [], byRepo: [], monthToDate: null };
  const minutes = billing.items.filter((i) => /minute/i.test(i.unitType));
  const roll = <K extends string>(key: K, items: typeof minutes) =>
    [...groupBy(items, (i) => (key === "month" ? i.date.slice(0, 7) : i.repositoryName || "(unattributed)")).entries()].map(([k, list]) => ({
      [key]: k,
      minutes: round(sum(list.map((i) => i.quantity)), 1),
      grossUsd: round(sum(list.map((i) => i.grossAmount)), 2),
      netUsd: round(sum(list.map((i) => i.netAmount)), 2),
    }));
  const month = window.until.slice(0, 7);
  const mtd = minutes.filter((i) => i.date.startsWith(month) && i.date <= window.until);
  const lastDate = mtd.reduce((m, i) => (i.date > m ? i.date : m), `${month}-01`);
  return {
    available: true,
    reason: null,
    byMonth: roll("month", minutes.filter((i) => repoMatches(i.repositoryName, repo))).sort((a, b) => String(a.month).localeCompare(String(b.month))),
    byRepo: roll("repo", minutes.filter((i) => i.date >= window.since && i.date <= window.until)).sort((a, b) => b.minutes - a.minutes),
    monthToDate: {
      month,
      throughDate: lastDate,
      daysElapsed: Number(lastDate.slice(8, 10)),
      orgMinutes: round(sum(mtd.map((i) => i.quantity)), 1),
      orgGrossUsd: round(sum(mtd.map((i) => i.grossAmount)), 2),
      orgNetUsd: round(sum(mtd.map((i) => i.netAmount)), 2),
      repoMinutes: round(sum(mtd.filter((i) => repoMatches(i.repositoryName, repo)).map((i) => i.quantity)), 1),
    },
  };
}

interface JobStat { workflow: string; job: string; n: number; meanSeconds: number; p50Seconds: number | null; meanBillable: number; shortShare: number | null }

export function billableSection(ctx: Context) {
  const { estimate, comparison, data, config } = ctx;
  const runsById = new Map(data.runs.map((r) => [r.id, r]));
  const sampled = data.sampledRunIds.map((id) => [runsById.get(id)!, data.jobs[String(id)] ?? []] as const).filter(([r]) => r);
  const queueWait: number[] = [];
  const steps = new Map<string, { workflow: string; job: string; step: string; seconds: number[] }>();
  const jobs = new Map<string, { workflow: string; job: string; seconds: number[]; billable: number[] }>();
  for (const [run, list] of sampled) {
    for (const job of list) {
      const wait = minutesBetween(job.createdAt, job.startedAt);
      if (wait !== null) queueWait.push(wait * 60);
      const m = jobMinutes(job);
      const jk = `${run.name}\u0000${job.name}`;
      if (!jobs.has(jk)) jobs.set(jk, { workflow: run.name, job: job.name, seconds: [], billable: [] });
      jobs.get(jk)!.seconds.push(m.real * 60);
      jobs.get(jk)!.billable.push(m.billable);
      for (const s of job.steps) {
        const sec = minutesBetween(s.startedAt, s.completedAt);
        if (sec === null) continue;
        const sk = `${jk}\u0000${s.name}`;
        if (!steps.has(sk)) steps.set(sk, { workflow: run.name, job: job.name, step: s.name, seconds: [] });
        steps.get(sk)!.seconds.push(sec * 60);
      }
    }
  }

  const threshold = config.shortJobSeconds;
  const byJob: JobStat[] = [...jobs.values()].map((j) => ({
    workflow: j.workflow,
    job: j.job,
    n: j.seconds.length,
    meanSeconds: round(sum(j.seconds) / j.seconds.length, 1),
    p50Seconds: distribution(j.seconds, 1).p50,
    meanBillable: round(sum(j.billable) / j.billable.length, 2),
    shortShare: rate(j.seconds.filter((s) => s > 0 && s < threshold).length, j.seconds.length),
  })).sort((a, b) => a.workflow.localeCompare(b.workflow) || a.job.localeCompare(b.job));

  // Rounding waste from short jobs, scaled from each stratum's sample to its run count.
  let shortWaste = 0;
  let shortJobsPerWindow = 0;
  for (const row of estimate.strata) {
    const ids = sampled.filter(([r]) => stratumKey(r) === row.stratum);
    if (!ids.length) continue;
    const perRun = ids.map(([, list]) => list.map(jobMinutes).filter((m) => m.real > 0 && m.real * 60 < threshold));
    shortWaste += (sum(perRun.map((l) => sum(l.map((m) => m.billable - m.real)))) / ids.length) * row.runs;
    shortJobsPerWindow += (sum(perRun.map((l) => l.length)) / ids.length) * row.runs;
  }
  const allJobs = sampled.flatMap(([, l]) => l).map(jobMinutes).filter((m) => m.real > 0);
  return {
    strata: estimate.strata,
    unsampled: estimate.unsampled,
    outliers: estimate.outliers,
    totals: estimate.totals,
    comparison,
    jobQueueWaitSeconds: distribution(queueWait, 1),
    slowestSteps: [...steps.values()]
      .filter((s) => s.seconds.length >= 3)
      .map((s) => ({ workflow: s.workflow, job: s.job, step: s.step, ...pick(distribution(s.seconds, 1)) }))
      .sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0))
      .slice(0, 15),
    byJob,
    shortJobs: {
      thresholdSeconds: threshold,
      sampledJobs: allJobs.length,
      shortJobs: allJobs.filter((m) => m.real * 60 < threshold).length,
      shortShare: rate(allJobs.filter((m) => m.real * 60 < threshold).length, allJobs.length),
      estimatedJobs: round(shortJobsPerWindow, 0),
      estimatedWasteMinutes: round(shortWaste, 1),
    },
    days: [...new Set(data.runs.map((r) => dayKey(r.createdAt)))].length,
  };
}

function pick(d: Distribution) {
  return { n: d.n, p50: d.p50, p90: d.p90, max: d.max };
}
