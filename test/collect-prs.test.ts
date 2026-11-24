import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { GitHubClient } from "../src/github/client.js";
import { collectPrs, listPrs } from "../src/collect/prs.js";
import type { RepoInfo } from "../src/types.js";
import { routes, status } from "./helpers/routes.js";

const repo: RepoInfo = { owner: "acme", name: "widgets", fullName: "acme/widgets", private: true, defaultBranch: "main" };
const window = { since: "2026-03-01", until: "2026-03-31" };
const now = new Date("2026-03-31T12:00:00Z");
const tmpCache = () => new Cache(mkdtempSync(join(tmpdir(), "ci-ledger-prs-")), "acme", "widgets");

const listing = {
  "GET /repos/acme/widgets/pulls": (url: URL) =>
    url.searchParams.get("state") === "open"
      ? [{ number: 3, updated_at: "2026-01-02T00:00:00Z" }]
      : [
          { number: 1, updated_at: "2026-03-20T00:00:00Z" },
          { number: 2, updated_at: "2026-03-10T00:00:00Z" },
          { number: 9, updated_at: "2026-02-01T00:00:00Z" },
        ],
};

function gqlPr(number: number, extra: Record<string, unknown> = {}) {
  return {
    id: `PR_${number}`, number, state: number === 3 ? "OPEN" : "MERGED", isDraft: false,
    createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-20T00:00:00Z",
    closedAt: number === 3 ? null : "2026-03-05T00:00:00Z", mergedAt: number === 3 ? null : "2026-03-05T00:00:00Z",
    baseRefName: "main", headRefName: `feature-${number}`, headRefOid: `sha${number}`,
    additions: 10, deletions: 5, author: { login: "dev", __typename: "User" },
    timelineItems: {
      pageInfo: { hasNextPage: number === 1, endCursor: number === 1 ? "c1" : null },
      nodes: [
        { __typename: "AddedToMergeQueueEvent", createdAt: "2026-03-04T00:00:00Z" },
        { __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-03-04T01:00:00Z", reason: "MERGE_CONFLICT" },
        { __typename: "PullRequestCommit", commit: { oid: "c", messageHeadline: "Merge branch 'main' into feature", committedDate: "2026-03-02T00:00:00Z" } },
        { __typename: "PullRequestReview", state: "APPROVED", submittedAt: "2026-03-03T00:00:00Z", author: { login: "rev", __typename: "User" } },
        { __typename: "PullRequestReview", state: "PENDING", submittedAt: null, author: { login: "rev", __typename: "User" } },
        { __typename: "LabeledEvent", createdAt: "2026-03-01T01:00:00Z", label: { name: "ready" } },
      ],
    },
    ...extra,
  };
}

test("listPrs stops paging at the window start and adds every open PR", async () => {
  const listed = await listPrs(new GitHubClient({ fetch: routes(listing) }), repo, "2026-03-01T00:00:00Z");
  assert.deepEqual(listed.map((l) => l.number), [1, 2, 3]);
});

test("GraphQL timelines are batched, paged and mapped; conflict ejections get file lists", async () => {
  const fetch = routes({
    ...listing,
    "POST /graphql": (_url, body) => {
      const { query } = body as { query: string };
      if (query.includes("node(id:")) {
        return { data: { node: { timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
          { __typename: "MergedEvent", createdAt: "2026-03-05T00:00:00Z" },
          { __typename: "HeadRefForcePushedEvent", createdAt: "2026-03-02T05:00:00Z" },
        ] } } } };
      }
      return { data: { repository: { p1: gqlPr(1), p2: gqlPr(2, { updatedAt: "2026-03-10T00:00:00Z" }), p3: gqlPr(3, { updatedAt: "2026-01-02T00:00:00Z" }) } } };
    },
    "GET /repos/acme/widgets/pulls/1/files": () => [{ filename: "src/registry.ts" }],
    "GET /repos/acme/widgets/pulls/2/files": () => [{ filename: "src/registry.ts" }, { filename: "README.md" }],
    "GET /repos/acme/widgets/compare/main...sha3": () => ({ behind_by: 42 }),
  });
  const cache = tmpCache();
  const result = await collectPrs(new GitHubClient({ fetch, token: "t" }), cache, repo, window, { now });
  assert.equal(result.source, "graphql");
  const [p1, , p3] = result.prs;
  assert.equal(p1?.state, "merged");
  assert.deepEqual(p1?.timeline.map((e) => e.type), ["labeled", "commit", "force_pushed", "review", "queue_added", "queue_removed", "merged"]);
  assert.deepEqual(p1?.files, ["src/registry.ts"]);
  assert.equal(p3?.behindBy, 42);
  assert.equal(fetch.calls.filter((c) => c.startsWith("POST /graphql")).length, 2);

  fetch.calls.length = 0;
  await collectPrs(new GitHubClient({ fetch, token: "t" }), cache, repo, window, { now });
  assert.equal(fetch.calls.filter((c) => c.startsWith("POST /graphql")).length, 0, "unchanged PRs come from the cache");
  assert.equal(fetch.calls.filter((c) => c.includes("/compare/")).length, 1, "idle open PRs get a fresh behind-base count");

  const offline = await collectPrs(new GitHubClient({ fetch: routes({}) }), cache, repo, window, { offline: true });
  assert.equal(offline.prs.length, 3);
});

test("a GraphQL error inside one batch falls back to REST for that batch only", async () => {
  let calls = 0;
  const fetch = routes({
    "GET /repos/acme/widgets/pulls": () => [{ number: 5, updated_at: "2026-03-10T00:00:00Z" }],
    "POST /graphql": () => (++calls, { errors: [{ message: "Something went wrong" }] }),
    "GET /repos/acme/widgets/pulls/5": () => ({
      number: 5, state: "open", created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-10T00:00:00Z", closed_at: null, merged_at: null,
      base: { ref: "main" }, head: { ref: "x", sha: "abc" }, additions: 1, deletions: 1, user: { login: "dev" },
    }),
    "GET /repos/acme/widgets/issues/5/timeline": () => [],
    "GET /repos/acme/widgets/pulls/5/commits": () => [],
    "GET /repos/acme/widgets/pulls/5/reviews": () => [],
  });
  const result = await collectPrs(new GitHubClient({ fetch, token: "t" }), tmpCache(), repo, window, { now });
  assert.equal(result.prs[0]?.source, "rest");
  assert.match(result.notes[0] ?? "", /error on one batch/);
  assert.equal(calls, 1);
});

test("REST timeline, commits and reviews are used when GraphQL is blocked", async () => {
  const fetch = routes({
    "GET /repos/acme/widgets/pulls": () => [{ number: 5, updated_at: "2026-03-10T00:00:00Z" }],
    "POST /graphql": () => status(403, "GraphQL is not allowed"),
    "GET /repos/acme/widgets/pulls/5": () => ({
      number: 5, state: "closed", draft: false, created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-10T00:00:00Z",
      closed_at: "2026-03-09T00:00:00Z", merged_at: "2026-03-09T00:00:00Z", base: { ref: "main" },
      head: { ref: "claude/fix", sha: "abc" }, additions: 120, deletions: 30, user: { login: "dev", type: "User" },
    }),
    "GET /repos/acme/widgets/issues/5/timeline": () => [
      { event: "added_to_merge_queue", created_at: "2026-03-08T00:00:00Z" },
      { event: "removed_from_merge_queue", created_at: "2026-03-08T00:30:00Z" },
      { event: "added_to_merge_queue", created_at: "2026-03-08T02:00:00Z" },
      { event: "merged", created_at: "2026-03-09T00:00:00Z" },
      { event: "commented", created_at: "2026-03-02T00:00:00Z" },
      { event: "labeled", created_at: "2026-03-02T00:00:00Z", label: { name: "bug" } },
    ],
    "GET /repos/acme/widgets/pulls/5/commits": () => [
      { sha: "a1", commit: { message: "Fix thing\n\nlong body", committer: { date: "2026-03-01T01:00:00Z" } } },
    ],
    "GET /repos/acme/widgets/pulls/5/reviews": () => [
      { state: "CHANGES_REQUESTED", submitted_at: "2026-03-03T00:00:00Z", user: { login: "review-bot[bot]", type: "Bot" } },
    ],
  });
  const result = await collectPrs(new GitHubClient({ fetch, token: "t", maxRetries: 0 }), tmpCache(), repo, window, { now });
  assert.equal(result.source, "rest");
  assert.match(result.notes[0] ?? "", /GraphQL unavailable/);
  const pr = result.prs[0]!;
  assert.equal(pr.source, "rest");
  assert.equal(pr.state, "merged");
  assert.equal(pr.timeline.filter((e) => e.type === "queue_added").length, 2);
  const commit = pr.timeline.find((e) => e.type === "commit");
  assert.equal(commit?.type === "commit" && commit.headline, "Fix thing");
  const review = pr.timeline.find((e) => e.type === "review");
  assert.equal(review?.type === "review" && review.authorIsBot, true);
});
