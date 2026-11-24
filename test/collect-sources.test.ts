import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { GitHubClient } from "../src/github/client.js";
import { collectJobs } from "../src/collect/jobs.js";
import { collectSetup, collectWorkflows } from "../src/collect/repo.js";
import { collectBilling, monthsOf } from "../src/collect/billing.js";
import { normalizeWorkflowName, planSample } from "../src/model/strata.js";
import type { RepoInfo, Run } from "../src/types.js";
import { routes, status } from "./helpers/routes.js";

const repo: RepoInfo = { owner: "acme", name: "widgets", fullName: "acme/widgets", private: true, defaultBranch: "main" };
const tmpCache = () => new Cache(mkdtempSync(join(tmpdir(), "ci-ledger-src-")), "acme", "widgets");

function run(id: number, name: string, event: string, minutes: number): Run {
  const start = Date.UTC(2026, 2, 1, 0, 0, 0) + id * 1000;
  return {
    id, workflowId: 1, name, path: "", event, status: "completed", conclusion: "success",
    headBranch: "b", headSha: `s${id}`, runAttempt: 1,
    createdAt: new Date(start).toISOString(), runStartedAt: new Date(start).toISOString(),
    updatedAt: new Date(start + minutes * 60_000).toISOString(),
    actor: null, triggeringActor: null, pullRequests: [], titlePr: null,
  };
}

const sampling = { perStratum: 12, minStratumRuns: 5, seed: "s", outlierMinutes: 120, maxOutlierRuns: 50 };

test("normalized workflow names merge digit variants", () => {
  assert.equal(normalizeWorkflowName("  Node 20   Tests "), "node # tests");
  assert.equal(normalizeWorkflowName("Node 22 Tests"), "node # tests");
});

test("planSample stratifies by workflow and event, caps at 12, skips small strata and outliers", () => {
  const runs = [
    ...Array.from({ length: 30 }, (_, i) => run(i + 1, "CI", "pull_request", 5)),
    ...Array.from({ length: 4 }, (_, i) => run(100 + i, "CI", "push", 5)),
    ...Array.from({ length: 6 }, (_, i) => run(200 + i, "Lint", "pull_request", 1)),
    run(300, "CI", "pull_request", 240),
  ];
  const plan = planSample(runs, sampling);
  assert.equal(plan.strata.get("ci|pull_request")?.length, 30);
  assert.equal(plan.strata.get("ci|push")?.length, 4);
  assert.deepEqual(plan.outlierRunIds, [300]);
  const sampled = new Set(plan.sampledRunIds);
  assert.equal(plan.sampledRunIds.length, 12 + 6);
  assert.ok(![100, 101, 102, 103].some((id) => sampled.has(id)));
  assert.ok(!sampled.has(300));
  assert.deepEqual(planSample([...runs].reverse(), sampling).sampledRunIds, plan.sampledRunIds);
  assert.notDeepEqual(planSample(runs, { ...sampling, seed: "other" }).sampledRunIds, plan.sampledRunIds);
});

test("collectJobs maps jobs and steps, caches per run, and reports missing runs offline", async () => {
  const fetch = routes({
    "GET /repos/acme/widgets/actions/runs/1/jobs": () => ({
      total_count: 1,
      jobs: [{
        id: 10, run_id: 1, name: "build", status: "completed", conclusion: "success",
        created_at: "2026-03-01T00:00:00Z", started_at: "2026-03-01T00:00:05Z", completed_at: "2026-03-01T00:01:05Z",
        labels: ["ubuntu-latest"], runner_group_name: "GitHub Actions",
        steps: [{ name: "Run tests", status: "completed", conclusion: "success", number: 1,
          started_at: "2026-03-01T00:00:10Z", completed_at: "2026-03-01T00:01:00Z" }],
      }],
    }),
  });
  const cache = tmpCache();
  const gh = new GitHubClient({ fetch });
  const first = await collectJobs(gh, cache, repo, [1]);
  assert.equal(first.jobs["1"]?.[0]?.steps[0]?.name, "Run tests");
  assert.ok(fetch.calls[0]?.includes("filter=latest"));
  await collectJobs(gh, cache, repo, [1]);
  assert.equal(fetch.calls.length, 1);
  const offline = await collectJobs(gh, cache, repo, [1, 2], { offline: true });
  assert.deepEqual(offline.missing, [2]);
});

test("workflow files are read from the default branch and decoded", async () => {
  const fetch = routes({
    "GET /repos/acme/widgets/contents/.github/workflows": () => [
      { name: "ci.yml", path: ".github/workflows/ci.yml", type: "file" },
      { name: "README.md", path: ".github/workflows/README.md", type: "file" },
    ],
    "GET /repos/acme/widgets/contents/.github/workflows/ci.yml": () => ({
      encoding: "base64",
      content: Buffer.from("on: [push]\n").toString("base64"),
    }),
  });
  const cache = tmpCache();
  const files = await collectWorkflows(new GitHubClient({ fetch }), cache, repo);
  assert.deepEqual(files, [{ path: ".github/workflows/ci.yml", content: "on: [push]\n" }]);
  assert.ok(fetch.calls.every((c) => c.includes("ref=main")));
  assert.deepEqual(await collectWorkflows(new GitHubClient({ fetch: routes({}) }), tmpCache(), repo), []);
});

test("setup reads required checks and the merge queue from rulesets", async () => {
  const fetch = routes({
    "GET /repos/acme/widgets/rules/branches/main": () => [
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }, { context: "lint" }] } },
      { type: "merge_queue", parameters: {} },
    ],
  });
  const setup = await collectSetup(new GitHubClient({ fetch }), tmpCache(), repo);
  assert.deepEqual(setup.requiredChecks, ["lint", "test"]);
  assert.equal(setup.requiredChecksSource, "rulesets");
  assert.equal(setup.mergeQueue, true);
});

test("setup falls back to branch protection and asks GraphQL about the merge queue", async () => {
  const fetch = routes({
    "GET /repos/acme/widgets/rules/branches/main": () => [],
    "GET /repos/acme/widgets/branches/main/protection/required_status_checks": () => ({
      contexts: ["build"], checks: [{ context: "build" }],
    }),
    "POST /graphql": () => ({ data: { repository: { mergeQueue: null } } }),
  });
  const setup = await collectSetup(new GitHubClient({ fetch }), tmpCache(), repo);
  assert.deepEqual(setup.requiredChecks, ["build"]);
  assert.equal(setup.requiredChecksSource, "branch-protection");
  assert.equal(setup.mergeQueue, false);

  const denied = routes({
    "GET /repos/acme/widgets/rules/branches/main": () => [],
    "GET /repos/acme/widgets/branches/main/protection/required_status_checks": () => status(403, "Resource not accessible"),
    "POST /graphql": () => status(403, "blocked"),
  });
  const unknown = await collectSetup(new GitHubClient({ fetch: denied, maxRetries: 0 }), tmpCache(), repo);
  assert.equal(unknown.requiredChecksSource, "unavailable");
  assert.equal(unknown.mergeQueue, false);
  assert.ok(unknown.notes.some((n) => n.includes("Administration")));
});

test("billing keeps Actions usage items for each month of the window", async () => {
  const fetch = routes({
    "GET /organizations/acme/settings/billing/usage": (url) => ({
      usageItems: [
        { date: `${url.searchParams.get("year")}-${String(url.searchParams.get("month")).padStart(2, "0")}-02T00:00:00Z`,
          product: "Actions", sku: "Actions Linux", quantity: 100, unitType: "Minutes",
          pricePerUnit: 0.006, grossAmount: 0.6, discountAmount: 0.6, netAmount: 0, repositoryName: "acme/widgets" },
        { date: "2026-02-02", product: "Packages", sku: "storage", quantity: 1, unitType: "GigabyteHours",
          grossAmount: 0.1, netAmount: 0.1, repositoryName: "acme/widgets" },
      ],
    }),
  });
  const window = { since: "2026-02-20", until: "2026-03-05" };
  assert.deepEqual(monthsOf(window), ["2026-02", "2026-03"]);
  const billing = await collectBilling(new GitHubClient({ fetch }), tmpCache(), "acme", window, { now: new Date("2026-03-05T00:00:00Z") });
  assert.equal(billing.status, "ok");
  assert.equal(billing.items.length, 2);
  assert.deepEqual(billing.items.map((i) => i.date), ["2026-02-02", "2026-03-02"]);
  assert.equal(billing.items[0]?.quantity, 100);
});

test("billing 403 or 404 makes billing unavailable with a reason, also offline", async () => {
  const cache = tmpCache();
  const fetch = routes({ "GET /organizations/acme/settings/billing/usage": () => status(403, "Must be an org owner") });
  const window = { since: "2026-03-01", until: "2026-03-05" };
  const billing = await collectBilling(new GitHubClient({ fetch, maxRetries: 0 }), cache, "acme", window);
  assert.equal(billing.status, "unavailable");
  assert.match(billing.reason ?? "", /org owner/);
  const offline = await collectBilling(new GitHubClient({ fetch }), cache, "acme", window, { offline: true });
  assert.equal(offline.status, "unavailable");
  assert.match(offline.reason ?? "", /org owner/);
  const user = routes({ "GET /organizations/someone/settings/billing/usage": () => status(404) });
  const missing = await collectBilling(new GitHubClient({ fetch: user }), tmpCache(), "someone", window);
  assert.match(missing.reason ?? "", /HTTP 404/);
});
