import type { PullRequest, Run } from "../types.js";

export type LinkMethod = "pull_requests" | "head_branch" | "merge_queue" | "run_name";

export interface LinkResult {
  /** Run id to PR number, for runs with exactly one matching PR. */
  prByRun: Map<number, number>;
  methods: Record<LinkMethod, number>;
  ambiguous: number;
  unlinked: number;
}

const PR_EVENTS = new Set(["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"]);
const QUEUE_BRANCH = /^gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/;
const BEFORE_MS = 5 * 60_000;
const AFTER_MS = 30 * 60_000;

/** PR number of a merge-queue run from its `gh-readonly-queue/<base>/pr-<n>-<sha>` head branch. */
export function queuePr(headBranch: string | null): number | null {
  const m = headBranch ? QUEUE_BRANCH.exec(headBranch) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Links each run to a PR, trying in order: `run.pull_requests`; for pull_request events, the PR whose
 * head branch matches and whose open window (5 minutes before creation to 30 minutes after close, or
 * now) contains the run; the merge-queue branch name; a "PR #<n>" run name. The first method that
 * finds any candidate decides, and a run counts toward a PR only when exactly one PR matches.
 */
export function linkRuns(runs: readonly Run[], prs: readonly PullRequest[], now = new Date()): LinkResult {
  const byBranch = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const list = byBranch.get(pr.headRef);
    if (list) list.push(pr);
    else byBranch.set(pr.headRef, [pr]);
  }
  const result: LinkResult = {
    prByRun: new Map(),
    methods: { pull_requests: 0, head_branch: 0, merge_queue: 0, run_name: 0 },
    ambiguous: 0,
    unlinked: 0,
  };
  const decide = (run: Run, candidates: number[], method: LinkMethod): boolean => {
    const unique = [...new Set(candidates)];
    if (unique.length === 0) return false;
    if (unique.length === 1) {
      result.prByRun.set(run.id, unique[0]!);
      result.methods[method]++;
    } else {
      result.ambiguous++;
    }
    return true;
  };

  for (const run of runs) {
    if (decide(run, run.pullRequests, "pull_requests")) continue;
    if (PR_EVENTS.has(run.event) && run.headBranch) {
      const t = Date.parse(run.createdAt);
      const matches = (byBranch.get(run.headBranch) ?? []).filter((pr) => {
        const open = Date.parse(pr.createdAt) - BEFORE_MS;
        const close = (pr.closedAt ? Date.parse(pr.closedAt) : now.getTime()) + AFTER_MS;
        return t >= open && t <= close;
      });
      if (decide(run, matches.map((pr) => pr.number), "head_branch")) continue;
    }
    const queued = queuePr(run.headBranch);
    if (queued !== null && decide(run, [queued], "merge_queue")) continue;
    if (run.titlePr !== null && decide(run, [run.titlePr], "run_name")) continue;
    result.unlinked++;
  }
  return result;
}
