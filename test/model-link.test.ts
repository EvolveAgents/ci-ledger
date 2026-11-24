import { test } from "node:test";
import assert from "node:assert/strict";
import { linkRuns, queuePr } from "../src/model/link.js";
import type { PullRequest, Run } from "../src/types.js";
import { syntheticDataset } from "./helpers/dataset.js";

function run(id: number, over: Partial<Run>): Run {
  return { id, workflowId: 1, name: "CI", path: "", event: "push", status: "completed", conclusion: "success", headBranch: null,
    headSha: "s", runAttempt: 1, createdAt: "2026-03-10T12:00:00Z", runStartedAt: null, updatedAt: "2026-03-10T12:05:00Z",
    actor: null, triggeringActor: null, pullRequests: [], titlePr: null, ...over };
}
function pr(number: number, headRef: string, createdAt: string, closedAt: string | null): PullRequest {
  return { number, state: closedAt ? "merged" : "open", draft: false, createdAt, updatedAt: createdAt, closedAt, mergedAt: closedAt,
    baseRef: "main", headRef, headSha: "h", additions: 1, deletions: 1, author: null, authorIsBot: false, timeline: [], source: "graphql" };
}

const prs = [
  pr(1, "feature", "2026-03-10T00:00:00Z", "2026-03-11T00:00:00Z"),
  pr(2, "feature", "2026-03-20T00:00:00Z", null),
  pr(3, "dup", "2026-03-01T00:00:00Z", null),
  pr(4, "dup", "2026-03-02T00:00:00Z", null),
];
const now = new Date("2026-03-31T00:00:00Z");

test("run.pull_requests wins when it names exactly one PR", () => {
  const r = linkRuns([run(1, { pullRequests: [7], event: "pull_request", headBranch: "feature" })], prs, now);
  assert.equal(r.prByRun.get(1), 7);
  assert.equal(r.methods.pull_requests, 1);
  const amb = linkRuns([run(1, { pullRequests: [7, 8] })], prs, now);
  assert.equal(amb.ambiguous, 1);
  assert.equal(amb.prByRun.size, 0);
});

test("pull_request runs match the head branch inside the PR's open window", () => {
  const r = linkRuns([
    run(1, { event: "pull_request", headBranch: "feature", createdAt: "2026-03-09T23:56:00Z" }),
    run(2, { event: "pull_request", headBranch: "feature", createdAt: "2026-03-11T00:29:00Z" }),
    run(3, { event: "pull_request", headBranch: "feature", createdAt: "2026-03-15T00:00:00Z" }),
    run(4, { event: "pull_request_target", headBranch: "feature", createdAt: "2026-03-25T00:00:00Z" }),
    run(5, { event: "pull_request", headBranch: "dup", createdAt: "2026-03-25T00:00:00Z" }),
    run(6, { event: "push", headBranch: "feature", createdAt: "2026-03-10T05:00:00Z" }),
  ], prs, now);
  assert.equal(r.prByRun.get(1), 1);
  assert.equal(r.prByRun.get(2), 1);
  assert.equal(r.prByRun.has(3), false, "between PR 1 closing and PR 2 opening");
  assert.equal(r.prByRun.get(4), 2);
  assert.equal(r.prByRun.has(5), false, "two open PRs share the branch");
  assert.equal(r.prByRun.has(6), false, "push events are not matched by branch");
  assert.equal(r.ambiguous, 1);
  assert.equal(r.unlinked, 2);
});

test("merge-queue branches and PR #<n> run names link too", () => {
  assert.equal(queuePr("gh-readonly-queue/main/pr-123-0123456789abcdef0123456789abcdef01234567"), 123);
  assert.equal(queuePr("gh-readonly-queue/release/v2/pr-9-abc123"), 9);
  assert.equal(queuePr("feature/pr-1-abc"), null);
  const r = linkRuns([
    run(1, { event: "merge_group", headBranch: "gh-readonly-queue/main/pr-55-abcdef" }),
    run(2, { event: "dynamic", titlePr: 56 }),
  ], prs, now);
  assert.equal(r.prByRun.get(1), 55);
  assert.equal(r.prByRun.get(2), 56);
  assert.deepEqual(r.methods, { pull_requests: 0, head_branch: 0, merge_queue: 1, run_name: 1 });
});

test("on the synthetic repo every PR-driven run links to one PR", async () => {
  const data = await syntheticDataset();
  const r = linkRuns(data.runs, data.prs, new Date("2026-10-31T00:00:00Z"));
  const prDriven = data.runs.filter((x) => x.event !== "push" && x.event !== "schedule" && !(x.event === "dynamic" && x.titlePr === null) && x.headBranch !== "main");
  assert.equal(r.ambiguous, 0);
  assert.equal(r.prByRun.size, prDriven.length);
  for (const m of ["pull_requests", "head_branch", "merge_queue", "run_name"] as const) assert.ok(r.methods[m] > 0, m);
});
