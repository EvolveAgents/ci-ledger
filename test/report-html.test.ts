import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { runFindings } from "../src/findings/index.js";
import { buildMetrics } from "../src/metrics/index.js";
import { renderReport } from "../src/report/html.js";
import { resolvePath } from "../src/util/path.js";
import { syntheticDataset } from "./helpers/dataset.js";

const now = new Date("2026-10-31T01:00:00Z");
async function render(fake = {}) {
  const config = defaultConfig();
  const m = buildMetrics(await syntheticDataset(fake), config, now);
  const f = runFindings(m, config, now);
  return { m, f, html: renderReport(m, f) };
}

test("report.html is self-contained and supports light and dark mode", async () => {
  const { html } = await render();
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script|<link|(src|href)="https?:|@import|url\(/i);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
});

test("page one shows the model error and the fixes ranked by minutes saved", async () => {
  const { m, f, html } = await render();
  const page1 = html.slice(0, html.indexOf("</section>"));
  assert.match(page1, /Model error/);
  assert.ok(page1.includes(`${m.model.errorPct}%`));
  const fixes = f.findings.filter((x) => x.kind === "fix");
  const positions = fixes.map((x) => page1.indexOf(`href="#${x.id}"`));
  assert.ok(positions.every((p) => p > 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.doesNotMatch(page1, /Lower confidence/);
});

test("every number tagged with a metrics.json path resolves", async () => {
  const { m, html } = await render();
  const paths = [...html.matchAll(/title="metrics\.json: ([^"]+)"/g)].map((x) => x[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  assert.ok(paths.length > 20);
  for (const p of paths) assert.notEqual(resolvePath(m, p), undefined, p);
});

test("without billing the report flags lower confidence on page one", async () => {
  const { html } = await render({ billing: false });
  const page1 = html.slice(0, html.indexOf("</section>"));
  assert.match(page1, /Lower confidence/);
  assert.match(page1, /unavailable/);
});

test("names from the repository are escaped", async () => {
  const { m, f } = await render();
  const html = renderReport({ ...m, repo: { ...m.repo, fullName: "<img onerror=x>/r" } }, f);
  assert.ok(!html.includes("<img onerror"));
  assert.ok(html.includes("&lt;img onerror=x&gt;/r"));
});
