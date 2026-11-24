import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { GitHubClient, GitHubError, resolveToken, type FetchLike } from "../src/github/client.js";
import { collectRuns, fetchDay, mapRun, slicesOf } from "../src/collect/runs.js";
import type { RepoInfo } from "../src/types.js";

const repo: RepoInfo = { owner: "acme", name: "widgets", fullName: "acme/widgets", private: true, defaultBranch: "main" };

function apiRun(id: number, createdAt: string) {
  return {
    id,
    workflow_id: 1,
    name: "CI",
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_branch: "feature",
    head_sha: `sha${id}`,
    run_attempt: 1,
    created_at: createdAt,
    run_started_at: createdAt,
    updated_at: createdAt,
    actor: { login: "dev" },
    triggering_actor: { login: "dev" },
    pull_requests: [],
    repository: { id: 7 },
  };
}

/** Serves `/actions/runs?created=` like GitHub: 100 per page, Link headers, and at most `cap` results per query. */
function fakeRunsApi(runs: ReturnType<typeof apiRun>[], cap = 1000) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    const u = new URL(url);
    const created = u.searchParams.get("created")!;
    calls.push(created);
    const [from, to] = created.includes("..")
      ? created.split("..")
      : [`${created}T00:00:00Z`, `${created}T23:59:59Z`];
    const matching = runs
      .filter((r) => r.created_at >= from! && r.created_at <= to!)
      .slice(0, cap);
    const page = Number(u.searchParams.get("page") ?? "1");
    const items = matching.slice((page - 1) * 100, page * 100);
    const headers = new Headers({ "content-type": "application/json" });
    if (page * 100 < matching.length) {
      u.searchParams.set("page", String(page + 1));
      headers.set("link", `<${u.toString()}>; rel="next"`);
    }
    return new Response(JSON.stringify({ total_count: matching.length, workflow_runs: items }), { status: 200, headers });
  };
  return { fetch, calls };
}

function runsOn(day: string, count: number, hours: number[], startId = 1) {
  return Array.from({ length: count }, (_, i) => {
    const h = hours[i % hours.length]!;
    const m = String(i % 60).padStart(2, "0");
    const s = String(Math.floor(i / 60) % 60).padStart(2, "0");
    return apiRun(startId + i, `${day}T${String(h).padStart(2, "0")}:${m}:${s}Z`);
  });
}

test("mapRun keeps PRs based on this repo and parses PR numbers from run names", () => {
  const run = mapRun({
    ...apiRun(1, "2026-03-01T00:00:00Z"),
    name: "CodeQL",
    display_title: "PR #42",
    path: ".github/workflows/ci.yml@refs/heads/main",
    pull_requests: [
      { number: 5, base: { repo: { id: 7 } } },
      { number: 9, base: { repo: { id: 99 } } },
    ],
  });
  assert.deepEqual(run.pullRequests, [5]);
  assert.equal(run.titlePr, 42);
  assert.equal(run.path, ".github/workflows/ci.yml");
});

test("slicesOf covers the day in 4-hour created= ranges", () => {
  const s = slicesOf("2026-03-01");
  assert.equal(s.length, 6);
  assert.equal(s[0], "2026-03-01T00:00:00Z..2026-03-01T03:59:59Z");
  assert.equal(s[5], "2026-03-01T20:00:00Z..2026-03-01T23:59:59Z");
});

test("a day under the cap is fetched with one query", async () => {
  const api = fakeRunsApi(runsOn("2026-03-01", 250, [1, 9, 17]));
  const gh = new GitHubClient({ fetch: api.fetch });
  const { runs, truncated } = await fetchDay(gh, repo, "2026-03-01");
  assert.equal(runs.length, 250);
  assert.equal(truncated, false);
  assert.deepEqual(new Set(api.calls), new Set(["2026-03-01"]));
});

test("runs repeated across pages are counted once", async () => {
  const runs = runsOn("2026-03-01", 150, [3]);
  const api = fakeRunsApi([...runs.slice(0, 100), runs[99]!, ...runs.slice(100)]);
  const { runs: got } = await fetchDay(new GitHubClient({ fetch: api.fetch }), repo, "2026-03-01");
  assert.equal(got.length, 150);
});

test("a day at the cap is refetched in 4-hour slices and de-duplicated", async () => {
  const api = fakeRunsApi(runsOn("2026-03-01", 1500, [0, 5, 10, 15, 20]), 1000);
  const gh = new GitHubClient({ fetch: api.fetch });
  const { runs, truncated } = await fetchDay(gh, repo, "2026-03-01");
  assert.equal(runs.length, 1500);
  assert.equal(new Set(runs.map((r) => r.id)).size, 1500);
  assert.equal(truncated, false);
  assert.ok(api.calls.includes("2026-03-01T04:00:00Z..2026-03-01T07:59:59Z"));
});

test("a slice still at the cap falls back to hours and flags truncation", async () => {
  const api = fakeRunsApi(runsOn("2026-03-01", 130, [2]), 100);
  const gh = new GitHubClient({ fetch: api.fetch });
  const { runs, truncated } = await fetchDay(gh, repo, "2026-03-01", 100);
  assert.equal(truncated, true);
  assert.equal(runs.length, 100);
  assert.ok(api.calls.includes("2026-03-01T02:00:00Z..2026-03-01T02:59:59Z"));
});

test("collectRuns caches finished days and refetches only today", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-ledger-runs-"));
  const cache = new Cache(dir, repo.owner, repo.name);
  const data = [...runsOn("2026-03-01", 3, [8]), ...runsOn("2026-03-02", 2, [8], 100)];
  const api = fakeRunsApi(data);
  const gh = new GitHubClient({ fetch: api.fetch });
  const now = new Date("2026-03-02T12:00:00Z");
  const window = { since: "2026-03-01", until: "2026-03-02" };
  const first = await collectRuns(gh, cache, repo, window, { now });
  assert.equal(first.runs.length, 5);
  assert.equal(cache.read<{ complete: boolean }>("runs/2026-03-01.json")?.complete, true);
  assert.equal(cache.read<{ complete: boolean }>("runs/2026-03-02.json")?.complete, false);

  api.calls.length = 0;
  await collectRuns(gh, cache, repo, window, { now });
  assert.deepEqual(api.calls, ["2026-03-02"]);

  const offline = await collectRuns(gh, cache, repo, { since: "2026-02-28", until: "2026-03-02" }, { now, offline: true });
  assert.equal(offline.runs.length, 5);
  assert.deepEqual(offline.missingDays, ["2026-02-28"]);
});

test("client retries 5xx and rate limits, then surfaces errors with status", async () => {
  let n = 0;
  const slept: number[] = [];
  const fetch: FetchLike = async () => {
    n++;
    if (n === 1) return new Response("bad gateway", { status: 502 });
    if (n === 2) {
      const reset = String(Math.floor(Date.now() / 1000) + 2);
      return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    }
    if (n === 3) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
  const gh = new GitHubClient({ fetch, sleep: async (ms) => void slept.push(ms) });
  const { data } = await gh.request<{ ok: boolean }>("/x");
  assert.equal(data.ok, true);
  assert.equal(slept.length, 2);
  await assert.rejects(gh.request("/missing"), (err: unknown) => err instanceof GitHubError && err.status === 404);
});

test("graphql errors become GitHubError", async () => {
  const fetch: FetchLike = async () => new Response(JSON.stringify({ errors: [{ message: "denied" }] }), { status: 200 });
  const gh = new GitHubClient({ fetch, token: "t" });
  await assert.rejects(gh.graphql("{ viewer { login } }", {}), /GraphQL: denied/);
});

test("token resolution prefers GITHUB_TOKEN, then GH_TOKEN, then gh auth token", async () => {
  const gh = async () => ({ stdout: "from-gh\n" });
  const fail = async () => {
    throw new Error("no gh");
  };
  assert.deepEqual(await resolveToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }, gh), { token: "a", source: "GITHUB_TOKEN" });
  assert.deepEqual(await resolveToken({ GH_TOKEN: "b" }, gh), { token: "b", source: "GH_TOKEN" });
  assert.deepEqual(await resolveToken({}, gh), { token: "from-gh", source: "gh auth token" });
  assert.deepEqual(await resolveToken({}, fail), { token: null, source: "none" });
});
