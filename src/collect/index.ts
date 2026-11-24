import { Cache } from "../cache.js";
import type { Config, Window } from "../config.js";
import { GitHubClient, type FetchLike } from "../github/client.js";
import { planSample } from "../model/strata.js";
import type { Dataset } from "../types.js";
import { collectBilling } from "./billing.js";
import { collectJobs } from "./jobs.js";
import { collectPrs } from "./prs.js";
import { collectRepo, collectSetup, collectWorkflows } from "./repo.js";
import { collectRuns } from "./runs.js";

export interface CollectOptions {
  repo: string;
  /** Org whose billing to read; defaults to the repo owner. */
  org?: string;
  window: Window;
  cacheDir: string;
  config: Config;
  /** Read only from the cache (`--from-cache`). */
  offline?: boolean;
  token?: string | null;
  fetch?: FetchLike;
  skipBilling?: boolean;
  forceRest?: boolean;
  now?: Date;
  log?: (message: string) => void;
}

export function parseRepo(value: string): { owner: string; name: string } {
  const m = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`--repo must look like owner/name, got "${value}"`);
  return { owner: m[1]!, name: m[2]! };
}

/** Gathers every input for one repo and window, from GitHub (resumable through the cache) or from the cache alone. */
export async function collect(options: CollectOptions): Promise<Dataset> {
  const { owner, name } = parseRepo(options.repo);
  const log = options.log ?? (() => {});
  const offline = options.offline ?? false;
  const gh = new GitHubClient({ token: options.token, fetch: options.fetch, log });
  const cache = new Cache(options.cacheDir, owner, name);
  const notes: string[] = [];
  const { config, window } = options;

  const repo = await collectRepo(gh, cache, owner, name, offline);
  log(`collecting ${repo.fullName} ${window.since}..${window.until}${offline ? " from cache" : ""}`);

  const runs = await collectRuns(gh, cache, repo, window, { now: options.now, log, offline });
  if (runs.missingDays.length) notes.push(`${runs.missingDays.length} days of runs were not in the cache: ${runs.missingDays.join(", ")}`);
  if (runs.truncatedDays.length) notes.push(`run listings hit the 1,000-result cap even in 1-hour slices on ${runs.truncatedDays.join(", ")}; some runs are missing`);
  log(`${runs.runs.length} runs`);

  const plan = planSample(runs.runs, { ...config.sampling, outlierMinutes: config.outlierMinutes });
  const { jobs, missing } = await collectJobs(gh, cache, repo, [...plan.sampledRunIds, ...plan.outlierRunIds], { offline, log });
  if (missing.length) notes.push(`jobs missing for ${missing.length} sampled runs`);
  log(`jobs for ${Object.keys(jobs).length} runs (${plan.sampledRunIds.length} sampled, ${plan.outlierRunIds.length} outlier runs)`);

  const prs = await collectPrs(gh, cache, repo, window, { offline, rest: options.forceRest, staleDays: config.staleDays, now: options.now, log });
  notes.push(...prs.notes);
  log(`${prs.prs.length} pull requests (${prs.source})`);

  const org = options.org ?? repo.owner;
  const billing = options.skipBilling
    ? { status: "unavailable" as const, reason: "billing was skipped (--no-billing)", org, months: [], items: [] }
    : await collectBilling(gh, cache, org, window, { offline, now: options.now });
  if (billing.status !== "ok") log(`billing unavailable: ${billing.reason}`);

  const workflows = await collectWorkflows(gh, cache, repo, offline);
  const setup = await collectSetup(gh, cache, repo, offline);
  if (!offline) log(`${gh.requests} API requests`);

  return {
    schemaVersion: 1,
    repo,
    window,
    collectedAt: (options.now ?? new Date()).toISOString(),
    runs: runs.runs,
    jobs,
    sampledRunIds: plan.sampledRunIds.filter((id) => jobs[String(id)]),
    outlierRunIds: plan.outlierRunIds.filter((id) => jobs[String(id)]),
    prs: prs.prs,
    billing,
    workflows,
    setup,
    notes,
  };
}
