import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, parseRepo } from "../src/collect/index.js";
import { defaultConfig } from "../src/config.js";
import { buildWorld } from "../src/fixtures/synthetic.js";
import { fakeGitHub } from "../src/fixtures/fake-github.js";

const world = buildWorld();
const base = () => ({
  repo: "example-org/widgets",
  window: { since: world.since, until: world.until },
  config: defaultConfig(),
  now: world.now,
  cacheDir: mkdtempSync(join(tmpdir(), "ci-ledger-e2e-")),
});

test("the synthetic world is deterministic and plausible", () => {
  const again = buildWorld();
  assert.equal(again.runs.length, world.runs.length);
  assert.deepEqual(again.runs.slice(0, 5).map((r) => r.id), world.runs.slice(0, 5).map((r) => r.id));
  assert.ok(world.runs.length > 800, `runs: ${world.runs.length}`);
  assert.ok(world.prs.filter((p) => p.state === "merged").length > 40);
  assert.ok(world.runs.some((r) => r.event === "merge_group"));
  assert.equal(world.since, "2026-10-01");
  assert.equal(world.until, "2026-10-30");
});

test("collect gathers every source from the fake API, then replays identically from cache", async () => {
  const options = base();
  const online = await collect({ ...options, fetch: fakeGitHub(world), token: "t" });
  assert.equal(online.runs.length, world.runs.length);
  assert.ok(online.sampledRunIds.length > 50);
  assert.ok(online.outlierRunIds.length >= 1, "the stuck nightly run is an outlier");
  assert.equal(online.billing.status, "ok");
  assert.equal(online.setup.mergeQueue, true);
  assert.deepEqual(online.setup.requiredChecks, ["build", "e2e", "test"]);
  assert.equal(online.workflows.length, 5);
  assert.ok(online.prs.every((p) => p.source === "graphql"));
  assert.ok(online.prs.some((p) => p.files?.includes("src/registry.ts")));
  assert.ok(online.prs.some((p) => (p.behindBy ?? 0) > 0));

  const offline = await collect({ ...options, offline: true, fetch: async () => { throw new Error("no network"); } });
  assert.deepEqual({ ...offline, collectedAt: "" }, { ...online, collectedAt: "" });
});

test("collect falls back to REST timelines and marks billing unavailable on 403", async () => {
  const data = await collect({ ...base(), fetch: fakeGitHub(world, { graphql: false, billing: false }), token: "t" });
  assert.ok(data.prs.length > 0 && data.prs.every((p) => p.source === "rest"));
  assert.ok(data.notes.some((n) => n.includes("GraphQL unavailable")));
  assert.equal(data.billing.status, "unavailable");
  assert.match(data.billing.reason ?? "", /org owner/);
});

test("parseRepo validates owner/name", () => {
  assert.deepEqual(parseRepo("a-b/c.d"), { owner: "a-b", name: "c.d" });
  assert.throws(() => parseRepo("nope"), /owner\/name/);
});
