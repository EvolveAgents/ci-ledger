import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, mergeConfig, resolveWindow } from "../src/config.js";
import { main } from "../src/cli.js";

test("default rates come from config/rates.json with Linux 2-core at $0.006", () => {
  const linux = defaultConfig().rates.runners.find((r) => r.sku === "linux-2-core");
  assert.equal(linux?.perMinute, 0.006);
  assert.ok(linux?.labels.includes("ubuntu-latest"));
});

test("config file overrides merge deeply and arrays replace", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-ledger-config-"));
  const file = join(dir, "ci-ledger.config.json");
  writeFileSync(file, JSON.stringify({ outlierMinutes: 90, sampling: { perStratum: 6 }, botReviewers: ["review-bot"] }));
  const config = loadConfig(file);
  assert.equal(config.outlierMinutes, 90);
  assert.equal(config.sampling.perStratum, 6);
  assert.equal(config.sampling.minStratumRuns, 5);
  assert.deepEqual(config.botReviewers, ["review-bot"]);
  assert.deepEqual(mergeConfig({ a: [1, 2] }, { a: [3] }), { a: [3] });
});

test("invalid regular expressions in workflow groups are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-ledger-config-"));
  const file = join(dir, "bad.json");
  writeFileSync(file, JSON.stringify({ workflowGroups: [{ group: "x", name: "(" }] }));
  assert.throws(() => loadConfig(file), /not a valid regular expression/);
});

test("window defaults to the last 30 days and flags win", () => {
  const now = new Date("2026-03-31T10:00:00Z");
  assert.deepEqual(resolveWindow(defaultConfig(), {}, now), { since: "2026-03-02", until: "2026-03-31" });
  assert.deepEqual(resolveWindow(defaultConfig(), { since: "2026-03-10", until: "2026-03-12" }, now), {
    since: "2026-03-10",
    until: "2026-03-12",
  });
  assert.throws(() => resolveWindow(defaultConfig(), { since: "03/10/2026" }, now), /YYYY-MM-DD/);
  assert.throws(() => resolveWindow(defaultConfig(), { since: "2026-03-12", until: "2026-03-10" }, now), /after/);
});

test("cli prints help and rejects unknown commands", async () => {
  assert.equal(await main(["--help"]), 0);
  assert.equal(await main(["nope"]), 2);
});
