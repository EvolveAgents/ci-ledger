import type { Cache } from "../cache.js";
import type { GitHubClient } from "../github/client.js";
import type { RepoInfo, Run } from "../types.js";
import { daysBetween, todayUtc } from "../util/time.js";

/** The runs list endpoint stops returning results after 1,000 matches for a filtered query. */
export const SEARCH_CAP = 1000;

interface ApiRun {
  id: number;
  workflow_id: number;
  name?: string | null;
  display_title?: string | null;
  path?: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  run_attempt?: number;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
  pull_requests?: Array<{ number: number; base?: { repo?: { id?: number } } }>;
  repository?: { id?: number };
}

const PR_IN_TITLE = /\bPR #(\d+)\b/;

export function mapRun(api: ApiRun): Run {
  const repoId = api.repository?.id;
  const prs = (api.pull_requests ?? [])
    .filter((pr) => repoId === undefined || pr.base?.repo?.id === undefined || pr.base.repo.id === repoId)
    .map((pr) => pr.number);
  const titleMatch = PR_IN_TITLE.exec(api.name ?? "") ?? PR_IN_TITLE.exec(api.display_title ?? "");
  return {
    id: api.id,
    workflowId: api.workflow_id,
    name: api.name ?? "",
    path: (api.path ?? "").replace(/@.*$/, ""),
    event: api.event,
    status: api.status ?? "unknown",
    conclusion: api.conclusion,
    headBranch: api.head_branch,
    headSha: api.head_sha,
    runAttempt: api.run_attempt ?? 1,
    createdAt: api.created_at,
    runStartedAt: api.run_started_at ?? null,
    updatedAt: api.updated_at,
    actor: api.actor?.login ?? null,
    triggeringActor: api.triggering_actor?.login ?? null,
    pullRequests: [...new Set(prs)],
    titlePr: titleMatch ? Number(titleMatch[1]) : null,
  };
}

interface DayFile {
  day: string;
  complete: boolean;
  truncated: boolean;
  fetchedAt: string;
  runs: Run[];
}

export interface RunsOptions {
  cap?: number;
  now?: Date;
  log?: (message: string) => void;
  /** Read only from the cache; missing days are reported and skipped. */
  offline?: boolean;
}

async function fetchRange(gh: GitHubClient, repo: RepoInfo, range: string, cap: number): Promise<Run[]> {
  const path = `/repos/${repo.owner}/${repo.name}/actions/runs?created=${encodeURIComponent(range)}&per_page=100`;
  const api = await gh.list<ApiRun, { workflow_runs: ApiRun[] }>(path, (p) => p.workflow_runs ?? [], cap);
  return api.map(mapRun);
}

/** 4-hour slices of a day, as `created=` ranges. */
export function slicesOf(day: string, hours = 4): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h += hours) {
    const from = `${day}T${String(h).padStart(2, "0")}:00:00Z`;
    const to = `${day}T${String(h + hours - 1).padStart(2, "0")}:59:59Z`;
    out.push(`${from}..${to}`);
  }
  return out;
}

/**
 * Fetches one day. When the day hits the cap, refetches it in 4-hour slices, and any slice that
 * still hits the cap in 1-hour slices. Returns runs de-duplicated by id.
 */
export async function fetchDay(
  gh: GitHubClient,
  repo: RepoInfo,
  day: string,
  cap = SEARCH_CAP,
  log: (m: string) => void = () => {},
): Promise<{ runs: Run[]; truncated: boolean }> {
  const whole = await fetchRange(gh, repo, day, cap);
  // The list is newest first, so a run created while paging shifts items across a page boundary
  // and can appear twice; de-duplicate by id.
  if (whole.length < cap) return { runs: [...new Map(whole.map((r) => [r.id, r])).values()], truncated: false };
  log(`${day}: ${whole.length}+ runs, refetching in 4-hour slices`);
  const byId = new Map<number, Run>();
  let truncated = false;
  for (const slice of slicesOf(day, 4)) {
    let runs = await fetchRange(gh, repo, slice, cap);
    if (runs.length >= cap) {
      const hour = Number(slice.slice(11, 13));
      runs = [];
      for (let h = hour; h < hour + 4; h++) {
        const hh = String(h).padStart(2, "0");
        const part = await fetchRange(gh, repo, `${day}T${hh}:00:00Z..${day}T${hh}:59:59Z`, cap);
        if (part.length >= cap) truncated = true;
        runs.push(...part);
      }
    }
    for (const r of runs) byId.set(r.id, r);
  }
  if (truncated) log(`${day}: an hour still returned ${cap}+ runs; some runs are missing`);
  return { runs: [...byId.values()], truncated };
}

/**
 * Workflow runs created in the window, one cache file per day. A day is final (never refetched)
 * once it is in the past and every run in it has completed.
 */
export async function collectRuns(
  gh: GitHubClient,
  cache: Cache,
  repo: RepoInfo,
  window: { since: string; until: string },
  options: RunsOptions = {},
): Promise<{ runs: Run[]; truncatedDays: string[]; missingDays: string[] }> {
  const cap = options.cap ?? SEARCH_CAP;
  const log = options.log ?? (() => {});
  const today = todayUtc(options.now);
  const all: Run[] = [];
  const truncatedDays: string[] = [];
  const missingDays: string[] = [];
  for (const day of daysBetween(window.since, window.until)) {
    const rel = `runs/${day}.json`;
    let file = cache.read<DayFile>(rel);
    if (!file || (!file.complete && !options.offline)) {
      if (options.offline) {
        missingDays.push(day);
        continue;
      }
      if (day > today) continue;
      const { runs, truncated } = await fetchDay(gh, repo, day, cap, log);
      file = {
        day,
        complete: day < today && runs.every((r) => r.status === "completed"),
        truncated,
        fetchedAt: (options.now ?? new Date()).toISOString(),
        runs,
      };
      cache.write(rel, file);
    }
    if (file.truncated) truncatedDays.push(day);
    all.push(...file.runs);
  }
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  return { runs: all, truncatedDays, missingDays };
}
