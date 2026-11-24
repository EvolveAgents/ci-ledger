/**
 * A deterministic, entirely synthetic repository ("example-org/widgets") used for tests, demos and
 * `--fixture` mode. Every name, login, number and time here is generated; none comes from a real repo.
 * The world is rendered to GitHub API response shapes by fake-github.ts.
 */
import { rngFor } from "../util/rng.js";

export interface WStep { name: string; seconds: number }
export interface WJobTemplate { name: string; seconds: number; failRate?: number; steps?: WStep[]; labels?: string[] }
export interface WWorkflow { name: string; path: string; jobs: WJobTemplate[]; parallel: boolean }

export interface WJob {
  id: number; run_id: number; name: string; status: "completed"; conclusion: string;
  created_at: string; started_at: string; completed_at: string; labels: string[]; runner_group_name: string;
  steps: Array<{ name: string; status: "completed"; conclusion: string; number: number; started_at: string; completed_at: string }>;
}
export interface WRun {
  id: number; workflow_id: number; name: string; display_title: string; path: string; event: string;
  status: "completed"; conclusion: string; head_branch: string; head_sha: string; run_attempt: number;
  created_at: string; run_started_at: string; updated_at: string;
  actor: { login: string }; triggering_actor: { login: string };
  pull_requests: Array<{ number: number; base: { repo: { id: number } } }>;
  repository: { id: number };
  jobs: WJob[];
  /** Billable minutes of earlier attempts, which `filter=latest` does not return. */
  earlierAttemptMinutes: number;
}
export type WEvent =
  | { type: "queue_added" | "merged" | "force_pushed" | "review_dismissed"; at: string }
  | { type: "queue_removed"; at: string; reason: string }
  | { type: "review"; at: string; state: string; author: string; bot: boolean }
  | { type: "labeled" | "unlabeled"; at: string; label: string }
  | { type: "commit"; at: string; sha: string; headline: string };
export interface WPr {
  number: number; state: "open" | "closed" | "merged"; draft: boolean;
  created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null;
  base: string; head: string; head_sha: string; additions: number; deletions: number;
  author: { login: string; bot: boolean }; events: WEvent[]; files: string[]; behind_by: number;
}
export interface WorldOptions { seed?: string; since?: string; days?: number; prs?: number }
export interface World {
  repo: { id: number; owner: string; name: string; private: boolean; default_branch: string };
  since: string; until: string; now: Date;
  workflows: Array<{ path: string; content: string }>;
  requiredChecks: string[]; mergeQueue: boolean;
  runs: WRun[]; prs: WPr[];
  billing: Array<{ date: string; product: string; sku: string; quantity: number; unitType: string; pricePerUnit: number;
    grossAmount: number; discountAmount: number; netAmount: number; organizationName: string; repositoryName: string }>;
}

const step = (name: string, seconds: number): WStep => ({ name, seconds });
const setup = [step("Set up job", 2), step("Run actions/checkout@v4", 3), step("Run actions/setup-node@v4", 8)];

export const WORKFLOWS: Record<string, WWorkflow> = {
  ci: { name: "CI", path: ".github/workflows/ci.yml", parallel: true, jobs: [
    { name: "lint", seconds: 32, steps: [...setup, step("Run npm run lint", 15)] },
    { name: "typecheck", seconds: 45, steps: [...setup, step("Run npx tsc --noEmit", 28)] },
    { name: "test", seconds: 330, failRate: 0.07, steps: [...setup, step("Run npm ci", 45), step("Run npm test", 265)] },
    { name: "build", seconds: 170, steps: [...setup, step("Run npm ci", 45), step("Run npm run build", 105)] },
  ] },
  e2e: { name: "E2E", path: ".github/workflows/e2e.yml", parallel: true, jobs: [
    { name: "e2e", seconds: 520, failRate: 0.06, steps: [...setup, step("Run npm ci", 45), step("Run npm test", 200), step("Run npx playwright test", 250)] },
  ] },
  labeler: { name: "PR Labeler", path: ".github/workflows/labeler.yml", parallel: true, jobs: [
    { name: "label", seconds: 14, steps: [step("Set up job", 2), step("Run actions/labeler@v5", 9)] },
  ] },
  status: { name: "Release Status", path: ".github/workflows/release-status.yml", parallel: true, jobs: [
    { name: "check", seconds: 22, failRate: 0.68, steps: [step("Set up job", 2), step("Run ./scripts/release-ready.sh", 15)] },
  ] },
  codeql: { name: "CodeQL", path: "dynamic/github-code-scanning/codeql", parallel: true, jobs: [
    { name: "Analyze (javascript-typescript)", seconds: 250, steps: [step("Initialize CodeQL", 40), step("Perform CodeQL Analysis", 190)] },
  ] },
  dependabot: { name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates", parallel: true, jobs: [
    { name: "Dependabot", seconds: 85, steps: [step("Run Dependabot", 80)] },
  ] },
  nightly: { name: "Nightly", path: ".github/workflows/nightly.yml", parallel: false, jobs: [
    { name: "full-suite", seconds: 2300, failRate: 0.1, labels: ["self-hosted", "linux", "x64"], steps: [step("Run npm run test:all", 2280)] },
    { name: "report", seconds: 40, steps: [step("Run ./scripts/report.sh", 30)] },
  ] },
};

const WORKFLOW_FILES: Record<string, string> = {
  ".github/workflows/ci.yml": `name: CI
on:
  pull_request:
  push:
    branches: [main]
  merge_group:
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx tsc --noEmit
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
`,
  ".github/workflows/e2e.yml": `name: E2E
on:
  pull_request:
  merge_group:
concurrency:
  group: e2e-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
      - run: npx playwright test
`,
  ".github/workflows/labeler.yml": `name: PR Labeler
on:
  pull_request_target:
    types: [opened, synchronize, labeled, unlabeled, edited]
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/labeler@v5
`,
  ".github/workflows/release-status.yml": `name: Release Status
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/release-ready.sh
`,
  ".github/workflows/nightly.yml": `name: Nightly
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  full-suite:
    runs-on: [self-hosted, linux, x64]
    timeout-minutes: 360
    steps:
      - run: npm run test:all
  report:
    needs: full-suite
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/report.sh
`,
};

const HOT_FILES = ["src/registry.ts", "package-lock.json"];
const OTHER_FILES = ["src/api.ts", "src/cli.ts", "src/db.ts", "src/ui/app.tsx", "src/ui/table.tsx", "docs/guide.md", "test/api.test.ts", "src/util.ts"];
const AGENTS = [
  { prefix: "codex/", author: "dev-a", share: 0.3, rework: 1 },
  { prefix: "claude/", author: "dev-b", share: 0.25, rework: 1 },
  { prefix: "copilot/", author: "Copilot", share: 0.1, rework: 2 },
  { prefix: "dependabot/npm_and_yarn/", author: "dependabot[bot]", share: 0.1, rework: 0, bot: true },
  { prefix: "feature/", author: "dev-c", share: 0.25, rework: 0 },
];
const HUMAN_REVIEWERS = ["reviewer-a", "reviewer-b", "reviewer-c"];

export function buildWorld(options: WorldOptions = {}): World {
  const seed = options.seed ?? "synthetic";
  const since = options.since ?? "2026-10-01";
  const days = options.days ?? 30;
  const rng = rngFor(seed, "world");
  const between = (a: number, b: number) => a + (b - a) * rng();
  const chance = (p: number) => rng() < p;
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = start + days * 86_400_000;
  const iso = (ms: number) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const repoId = 4242;
  let runId = 7_000_000;
  let jobId = 30_000_000;
  let shaN = 0;
  const sha = () => (++shaN).toString(16).padStart(8, "0").repeat(5);
  const runs: WRun[] = [];

  const addRun = (key: string, event: string, branch: string, headSha: string, at: number,
    o: { prs?: number[]; title?: string; fail?: boolean; actor?: string; force?: number } = {}): WRun => {
    const wf = WORKFLOWS[key]!;
    const id = ++runId;
    const queued = at + between(3, 25) * 1000;
    let t = queued;
    let conclusion = "success";
    const jobs: WJob[] = wf.jobs.map((tpl) => {
      const begin = wf.parallel ? queued + between(1, 20) * 1000 : t;
      const forced = o.force !== undefined && tpl === wf.jobs[0] ? o.force * 60 : undefined;
      const seconds = forced ?? tpl.seconds * between(0.8, 1.25);
      const failed = o.fail === true ? tpl.failRate !== undefined : o.fail === false ? false : chance(tpl.failRate ?? 0);
      const finish = begin + seconds * 1000;
      t = Math.max(t, finish);
      if (failed) conclusion = "failure";
      let s = begin;
      const steps = (tpl.steps ?? []).map((st, i) => {
        const len = st.seconds * (seconds / tpl.seconds);
        const out = { name: st.name, status: "completed" as const, conclusion: failed && i === tpl.steps!.length - 1 ? "failure" : "success",
          number: i + 1, started_at: iso(s), completed_at: iso(s + len * 1000) };
        s += len * 1000;
        return out;
      });
      return { id: ++jobId, run_id: id, name: tpl.name, status: "completed", conclusion: failed ? "failure" : "success",
        created_at: iso(at), started_at: iso(begin), completed_at: iso(finish),
        labels: tpl.labels ?? ["ubuntu-latest"], runner_group_name: tpl.labels ? "Default" : "GitHub Actions", steps };
    });
    const rerun = conclusion === "failure" && event === "pull_request" && chance(0.25);
    const earlier = rerun ? jobs.reduce((m, j) => m + Math.ceil((Date.parse(j.completed_at) - Date.parse(j.started_at)) / 60_000), 0) : 0;
    if (rerun) {
      for (const j of jobs) j.conclusion = "success";
      conclusion = "success";
    }
    const run: WRun = { id, workflow_id: Object.keys(WORKFLOWS).indexOf(key) + 100, name: wf.name, display_title: o.title ?? `${wf.name} on ${branch}`,
      path: wf.path, event, status: "completed", conclusion, head_branch: branch, head_sha: headSha, run_attempt: rerun ? 2 : 1,
      created_at: iso(at), run_started_at: iso(at), updated_at: iso(t + 4000),
      actor: { login: o.actor ?? "dev-c" }, triggering_actor: { login: o.actor ?? "dev-c" },
      pull_requests: (o.prs ?? []).map((number) => ({ number, base: { repo: { id: repoId } } })),
      repository: { id: repoId }, jobs, earlierAttemptMinutes: earlier };
    runs.push(run);
    return run;
  };

  const prs: WPr[] = [];
  const prCount = options.prs ?? 80;
  for (let i = 0; i < prCount; i++) {
    const number = 300 + i;
    let r = rng();
    const agent = AGENTS.find((a) => (r -= a.share) < 0) ?? AGENTS[AGENTS.length - 1]!;
    const branch = `${agent.prefix}change-${number}`;
    const created = between(start - 3 * 86_400_000, end - 2 * 86_400_000);
    const size = Math.max(4, Math.round(Math.exp(between(2.5, 7.6))));
    const heads = 1 + Math.floor(between(0, 2.5)) + agent.rework + (size >= 1200 ? 3 : size >= 300 ? 1 : 0);
    const files = [...new Set([...(chance(0.45) ? [HOT_FILES[Math.floor(between(0, 2))]!] : []),
      ...Array.from({ length: 1 + Math.floor(between(0, 4)) }, () => OTHER_FILES[Math.floor(between(0, OTHER_FILES.length))]!)])];
    const events: WEvent[] = [];
    const actor = agent.author;
    let at = created;
    let head = sha();
    const pushRuns = (headSha: string, when: number) => {
      addRun("ci", "pull_request", branch, headSha, when, { prs: [number], actor });
      addRun("e2e", "pull_request", branch, headSha, when, { prs: [number], actor });
      addRun("labeler", "pull_request_target", branch, headSha, when, { actor });
      addRun("codeql", "dynamic", branch, headSha, when + 30_000, { title: `PR #${number}`, actor: "github-advanced-security[bot]" });
      addRun("status", "workflow_run", branch, headSha, when + 420_000, { prs: [number], actor });
    };
    for (let h = 0; h < heads; h++) {
      if (h > 0) {
        at += between(1.5, 20) * 3_600_000;
        head = sha();
        if (chance(0.3)) events.push({ type: "force_pushed", at: iso(at) });
        if (chance(0.2)) events.push({ type: "commit", at: iso(at - 60_000), sha: head, headline: `Merge branch 'main' into ${branch}` });
      }
      events.push({ type: "commit", at: iso(at - 30_000), sha: head, headline: `Change ${number} part ${h + 1}` });
      pushRuns(head, at);
      if (h === 0 && chance(0.7)) events.push({ type: "review", at: iso(at + 900_000), state: "COMMENTED", author: "copilot-pull-request-reviewer", bot: true });
      if (h === 0 && heads > 1 && chance(0.5)) events.push({ type: "review", at: iso(at + 7_200_000), state: "CHANGES_REQUESTED", author: HUMAN_REVIEWERS[number % 3]!, bot: false });
      if (chance(0.35)) {
        const labelAt = at + between(10, 120) * 60_000;
        events.push({ type: "labeled", at: iso(labelAt), label: chance(0.5) ? "ready" : "needs-review" });
        addRun("labeler", "pull_request_target", branch, head, labelAt, { actor });
      }
    }
    const pr: WPr = { number, state: "open", draft: false, created_at: iso(created), updated_at: iso(at), closed_at: null, merged_at: null,
      base: "main", head: branch, head_sha: head, additions: Math.round(size * 0.7), deletions: Math.round(size * 0.3),
      author: { login: actor, bot: agent.bot === true }, events, files, behind_by: 0 };
    prs.push(pr);
    const outcome = rng();
    if (outcome > 0.9 || at > end - 86_400_000) continue;
    if (outcome > 0.84) {
      pr.state = "closed";
      pr.closed_at = pr.updated_at = iso(at + 86_400_000);
      continue;
    }
    if (chance(0.1)) events.push({ type: "review_dismissed", at: iso(at + 1_800_000) });
    at += between(1, 8) * 3_600_000;
    events.push({ type: "review", at: iso(at), state: "APPROVED", author: HUMAN_REVIEWERS[(number + 1) % 3]!, bot: false });
    for (let attempt = 0; ; attempt++) {
      at += between(0.2, 3) * 3_600_000;
      events.push({ type: "queue_added", at: iso(at) });
      const groupSha = sha();
      const groupBranch = `gh-readonly-queue/main/pr-${number}-${head}`;
      const roll = attempt >= 2 ? 1 : rng();
      if (roll < 0.12 || (roll < 0.25 && files.some((f) => HOT_FILES.includes(f)))) {
        at += between(2, 10) * 60_000;
        events.push({ type: "queue_removed", at: iso(at), reason: "MERGE_CONFLICT" });
        at += between(1, 6) * 3_600_000;
        head = sha();
        events.push({ type: "commit", at: iso(at - 60_000), sha: head, headline: `Merge branch 'main' into ${branch}` });
        pushRuns(head, at);
        continue;
      }
      const fail = roll < 0.4;
      const ci = addRun("ci", "merge_group", groupBranch, groupSha, at + 60_000, { fail: fail && chance(0.5) ? true : false, actor });
      const e2e = addRun("e2e", "merge_group", groupBranch, groupSha, at + 60_000, { fail: fail && ci.conclusion === "success" ? true : false, actor });
      at = Math.max(Date.parse(ci.updated_at), Date.parse(e2e.updated_at)) + 30_000;
      if (fail) {
        events.push({ type: "queue_removed", at: iso(at), reason: "FAILED_CHECKS" });
        continue;
      }
      events.push({ type: "merged", at: iso(at) });
      pr.state = "merged";
      pr.merged_at = pr.closed_at = pr.updated_at = iso(at);
      const mainSha = sha();
      addRun("ci", "push", "main", mainSha, at + 20_000, { actor });
      addRun("status", "workflow_run", "main", mainSha, at + 400_000, { actor });
      break;
    }
    pr.head_sha = head;
  }
  for (let i = 0; i < 5; i++) {
    const created = start - (40 + i * 6) * 86_400_000;
    prs.push({ number: 200 + i, state: "open", draft: i === 0, created_at: iso(created), updated_at: iso(created + 5 * 86_400_000),
      closed_at: null, merged_at: null, base: "main", head: `feature/old-${i}`, head_sha: sha(), additions: 300 + i * 50, deletions: 20,
      author: { login: "dev-c", bot: false }, events: [{ type: "commit", at: iso(created), sha: sha(), headline: "Start" }], files: [], behind_by: 60 + i * 9 });
  }
  for (let d = 0; d < days; d++) {
    const day = start + d * 86_400_000;
    addRun("nightly", "schedule", "main", sha(), day + 3 * 3_600_000, { actor: "dev-c", force: d === 11 ? 360 : undefined });
    if (d % 3 === 0) addRun("dependabot", "dynamic", "main", sha(), day + 6 * 3_600_000, { actor: "dependabot[bot]" });
  }
  const inWindow = runs.filter((x) => Date.parse(x.created_at) >= start && Date.parse(x.created_at) < end);
  inWindow.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  return { repo: { id: repoId, owner: "example-org", name: "widgets", private: true, default_branch: "main" },
    since, until: iso(end - 1000).slice(0, 10), now: new Date(end + 3_600_000),
    workflows: Object.entries(WORKFLOW_FILES).map(([path, content]) => ({ path, content })),
    requiredChecks: ["build", "e2e", "test"], mergeQueue: true, runs: inWindow, prs, billing: billingFor(inWindow, start, days) };
}

function billingFor(runs: WRun[], start: number, days: number): World["billing"] {
  const perDay = new Map<string, number>();
  for (const run of runs) {
    const minutes = run.earlierAttemptMinutes + run.jobs
      .filter((j) => !j.labels.includes("self-hosted"))
      .reduce((m, j) => m + Math.ceil((Date.parse(j.completed_at) - Date.parse(j.started_at)) / 60_000), 0);
    const day = run.created_at.slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + minutes);
  }
  const items: World["billing"] = [];
  let used = 0;
  const included = 3000;
  for (let d = 0; d < days; d++) {
    const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    for (const [repositoryName, quantity] of [["example-org/widgets", perDay.get(day) ?? 0], ["example-org/docs-site", 40 + (d % 7) * 9]] as const) {
      const gross = Math.round(quantity * 0.006 * 1000) / 1000;
      const free = Math.max(0, Math.min(quantity, included - used));
      used += quantity;
      const discount = Math.round(free * 0.006 * 1000) / 1000;
      items.push({ date: day, product: "actions", sku: "actions_linux", quantity, unitType: "Minutes", pricePerUnit: 0.006,
        grossAmount: gross, discountAmount: discount, netAmount: Math.round((gross - discount) * 1000) / 1000,
        organizationName: "example-org", repositoryName });
    }
  }
  return items;
}
