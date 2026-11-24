import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const log = console.log;
  const err = console.error;
  let out = "";
  console.log = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  console.error = () => {};
  try {
    return { result: await fn(), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("audit --fixture writes metrics.json and findings.json; findings and explain read them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-ledger-cli-"));
  const out = join(dir, "out");
  const cache = join(dir, "cache");
  const audit = await quiet(() => main(["audit", "--fixture", "--out", out, "--cache-dir", cache, "--quiet"]));
  assert.equal(audit.result, 0);
  assert.match(audit.out, /model error/);
  const metrics = JSON.parse(readFileSync(join(out, "metrics.json"), "utf8"));
  const findings = JSON.parse(readFileSync(join(out, "findings.json"), "utf8"));
  assert.equal(metrics.schema, "ci-ledger/metrics");
  assert.equal(findings.schema, "ci-ledger/findings");
  assert.ok(findings.findings.length >= 10);

  const list = await quiet(() => main(["findings", "--out", out]));
  assert.equal(list.result, 0);
  assert.match(list.out, /1\. duplicate-suites/);
  const ex = await quiet(() => main(["explain", "rounding-waste", "--out", out]));
  assert.equal(ex.result, 0);
  assert.match(ex.out, /billable\.shortJobs\.byWorkflow\[0\]/);
  assert.equal((await quiet(() => main(["explain", "nope", "--out", out]))).result, 1);

  const out2 = join(dir, "out2");
  const replay = await quiet(() =>
    main(["audit", "--repo", "example-org/widgets", "--since", "2026-10-01", "--until", "2026-10-30", "--from-cache", "--cache-dir", cache, "--out", out2, "--quiet"]),
  );
  assert.equal(replay.result, 0);
  const again = JSON.parse(readFileSync(join(out2, "findings.json"), "utf8"));
  assert.deepEqual(again.findings.map((f: { id: string }) => f.id), findings.findings.map((f: { id: string }) => f.id));
});

test("audit explains missing inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-ledger-cli-"));
  assert.equal((await quiet(() => main(["audit"]))).result, 1);
  assert.equal((await quiet(() => main(["audit", "--repo", "a/b", "--from-cache", "--cache-dir", dir, "--out", dir]))).result, 1);
  assert.equal((await quiet(() => main(["findings", "--out", join(dir, "missing")]))).result, 1);
  assert.equal(existsSync(join(dir, "metrics.json")), false);
});
