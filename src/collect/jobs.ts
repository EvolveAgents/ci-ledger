import type { Cache } from "../cache.js";
import { mapLimit, type GitHubClient } from "../github/client.js";
import type { Job, RepoInfo } from "../types.js";

interface ApiJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  labels?: string[];
  runner_group_name?: string | null;
  steps?: Array<{ name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }>;
}

export function mapJob(api: ApiJob): Job {
  return {
    id: api.id,
    runId: api.run_id,
    name: api.name,
    status: api.status,
    conclusion: api.conclusion,
    createdAt: api.created_at ?? null,
    startedAt: api.started_at ?? null,
    completedAt: api.completed_at ?? null,
    labels: api.labels ?? [],
    runnerGroup: api.runner_group_name ?? null,
    steps: (api.steps ?? []).map((s) => ({
      name: s.name,
      conclusion: s.conclusion,
      startedAt: s.started_at ?? null,
      completedAt: s.completed_at ?? null,
    })),
  };
}

/** Jobs of the latest attempt for each run id, one cache file per run. Missing runs are skipped offline. */
export async function collectJobs(
  gh: GitHubClient,
  cache: Cache,
  repo: RepoInfo,
  runIds: readonly number[],
  options: { offline?: boolean; concurrency?: number; log?: (m: string) => void } = {},
): Promise<{ jobs: Record<string, Job[]>; missing: number[] }> {
  const jobs: Record<string, Job[]> = {};
  const missing: number[] = [];
  let fetched = 0;
  await mapLimit([...new Set(runIds)], options.concurrency ?? 4, async (id) => {
    const rel = `jobs/${id}.json`;
    let list = cache.read<Job[]>(rel);
    if (!list) {
      if (options.offline) {
        missing.push(id);
        return;
      }
      const path = `/repos/${repo.owner}/${repo.name}/actions/runs/${id}/jobs?filter=latest&per_page=100`;
      try {
        const api = await gh.list<ApiJob, { jobs: ApiJob[] }>(path, (p) => p.jobs ?? []);
        list = api.map(mapJob);
      } catch (err) {
        options.log?.(`jobs for run ${id}: ${err instanceof Error ? err.message : String(err)}`);
        missing.push(id);
        return;
      }
      cache.write(rel, list);
      if (++fetched % 50 === 0) options.log?.(`fetched jobs for ${fetched} runs`);
    }
    jobs[String(id)] = list;
  });
  missing.sort((a, b) => a - b);
  return { jobs, missing };
}
