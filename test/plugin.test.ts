import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../src/paths.js";

const read = (p: string) => JSON.parse(readFileSync(join(PACKAGE_ROOT, p), "utf8"));
const pkg = read("package.json");
const claude = read("plugins/ci-ledger/.claude-plugin/plugin.json");
const codex = read("plugins/ci-ledger/.codex-plugin/plugin.json");
const market = read(".claude-plugin/marketplace.json");

test("plugin manifests agree with package.json", () => {
  for (const m of [claude, codex]) {
    assert.equal(m.name, "ci-ledger");
    assert.equal(m.version, pkg.version);
    assert.equal(m.license, pkg.license);
  }
  assert.equal(codex.skills, "./skills/");
  assert.ok(codex.interface.displayName && codex.interface.shortDescription);
});

test("the marketplace lists the plugin at a path that exists", () => {
  const entry = market.plugins.find((p: { name: string }) => p.name === claude.name);
  assert.ok(entry);
  assert.ok(existsSync(join(PACKAGE_ROOT, entry.source, ".claude-plugin", "plugin.json")));
});

test("each skill has frontmatter naming its directory and a description", () => {
  const dir = join(PACKAGE_ROOT, "plugins/ci-ledger/skills");
  const skills = readdirSync(dir);
  assert.deepEqual(skills.sort(), ["agents", "audit", "fix", "watch"]);
  for (const s of skills) {
    const text = readFileSync(join(dir, s, "SKILL.md"), "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    assert.match(front, new RegExp(`^name: ${s}$`, "m"), s);
    assert.match(front, /^description: .{40,}$/m, s);
  }
  assert.match(readFileSync(join(dir, "audit/SKILL.md"), "utf8"), /npx --yes ci-ledger audit/);
});
