import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { agentFor, isBot, isHumanReviewer, jobMatchesCheck, parseWorkflow, sizeBucket, workflowGroup } from "../src/model/classify.js";
import { buildWorld } from "../src/fixtures/synthetic.js";

const config = defaultConfig();

test("agents come from the branch prefix, then the PR author", () => {
  assert.equal(agentFor({ headRef: "codex/fix-1", author: "dev" }, config), "codex");
  assert.equal(agentFor({ headRef: "patch-1", author: "Copilot" }, config), "copilot");
  assert.equal(agentFor({ headRef: "dependabot/npm/x", author: "dependabot[bot]" }, config), "dependabot");
  assert.equal(agentFor({ headRef: "feature/x", author: "dev" }, config), "none");
});

test("bots are [bot] logins, GraphQL Bot authors, or configured logins; humans are everyone else", () => {
  assert.equal(isBot("coderabbitai[bot]", false, config), true);
  assert.equal(isBot("copilot-pull-request-reviewer", false, config), true);
  assert.equal(isBot("some-app", true, config), true);
  assert.equal(isBot("alice", false, config), false);
  assert.equal(isHumanReviewer("alice", false, config), true);
  assert.equal(isHumanReviewer("alice", false, { ...config, humanReviewers: ["bob"] }), false);
});

test("size buckets", () => {
  assert.deepEqual([99, 100, 299, 300, 1199, 1200].map(sizeBucket), ["<100", "100-299", "100-299", "300-1199", "300-1199", "1200+"]);
});

test("workflow files parse to triggers, concurrency and run commands", () => {
  const files = buildWorld().workflows;
  const labeler = parseWorkflow(files.find((f) => f.path.endsWith("labeler.yml"))!);
  assert.deepEqual(labeler.triggers.pull_request_target, ["opened", "synchronize", "labeled", "unlabeled", "edited"]);
  const e2e = parseWorkflow(files.find((f) => f.path.endsWith("e2e.yml"))!);
  assert.equal(e2e.concurrency?.cancelInProgress, true);
  assert.deepEqual(e2e.jobs[0]?.commands, ["npm ci", "npm test", "npx playwright test"]);
  const ci = parseWorkflow(files.find((f) => f.path.endsWith("ci.yml"))!);
  assert.equal(ci.concurrency, null);
  assert.deepEqual(Object.keys(ci.triggers), ["pull_request", "push", "merge_group"]);
  assert.equal(parseWorkflow({ path: "bad.yml", content: "on: [\n" }).parseError !== undefined, true);
  assert.deepEqual(parseWorkflow({ path: "x.yml", content: "on: push\njobs: {}\n" }).triggers, { push: null });
});

test("default grouping rules", () => {
  const files = buildWorld().workflows;
  const info = (p: string) => parseWorkflow(files.find((f) => f.path.endsWith(p))!);
  const g = (name: string, path: string, events: string[], hasRequiredCheck = false, file?: string) =>
    workflowGroup({ name, path, events, hasRequiredCheck, info: file ? info(file) : undefined }, config.workflowGroups);
  assert.equal(g("CI", ".github/workflows/ci.yml", ["pull_request"], true, "ci.yml"), "required");
  assert.equal(g("PR Labeler", ".github/workflows/labeler.yml", ["pull_request_target"], false, "labeler.yml"), "pr-automation");
  assert.equal(g("Release Status", ".github/workflows/release-status.yml", ["workflow_run"]), "pr-automation");
  assert.equal(g("CodeQL", "dynamic/github-code-scanning/codeql", ["dynamic"]), "code-scanning");
  assert.equal(g("Dependabot Updates", "dynamic/dependabot/dependabot-updates", ["dynamic"]), "dependabot");
  assert.equal(g("Nightly", ".github/workflows/nightly.yml", ["schedule"], false, "nightly.yml"), "other");
});

test("required check contexts match job names, matrix variants and workflow-prefixed names", () => {
  assert.equal(jobMatchesCheck("test", "test"), true);
  assert.equal(jobMatchesCheck("test (ubuntu, 22)", "test"), true);
  assert.equal(jobMatchesCheck("test", "CI / test", "CI"), true);
  assert.equal(jobMatchesCheck("testing", "test"), false);
});
