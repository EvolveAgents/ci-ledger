/**
 * Normalized records the collector keeps. They hold metadata only: no log text, no PR titles or bodies.
 * Field names are camelCase; the GitHub API shapes they come from are mapped in src/collect.
 */

export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface Run {
  id: number;
  workflowId: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
  headSha: string;
  runAttempt: number;
  createdAt: string;
  runStartedAt: string | null;
  updatedAt: string;
  actor: string | null;
  triggeringActor: string | null;
  /** PR numbers from `run.pull_requests`, limited to PRs whose base is this repository. */
  pullRequests: number[];
  /** PR number parsed from a "PR #<n>" run name or title (CodeQL-style). The text itself is not kept. */
  titlePr: number | null;
}

export interface Step {
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Job {
  id: number;
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  labels: string[];
  runnerGroup: string | null;
  steps: Step[];
}

export type TimelineEvent =
  | { type: "queue_added"; at: string }
  | { type: "queue_removed"; at: string; reason: string | null }
  | { type: "merged"; at: string }
  | { type: "force_pushed"; at: string }
  | { type: "review_dismissed"; at: string }
  | { type: "review"; at: string; state: string; author: string | null; authorIsBot: boolean }
  | { type: "labeled" | "unlabeled"; at: string; label: string }
  | { type: "commit"; at: string; sha: string; headline: string };

export interface PullRequest {
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  author: string | null;
  authorIsBot: boolean;
  timeline: TimelineEvent[];
  /** Changed file paths; collected only for PRs removed from the merge queue for a conflict. */
  files?: string[];
  /** Commits the head is behind its base; collected only for idle open PRs. */
  behindBy?: number | null;
  source: "graphql" | "rest";
}

export interface BillingItem {
  date: string;
  product: string;
  sku: string;
  unitType: string;
  repositoryName: string;
  quantity: number;
  grossAmount: number;
  netAmount: number;
}

export interface Billing {
  status: "ok" | "unavailable";
  /** Why billing is unavailable (for example a 403 because the token is not an org owner's). */
  reason?: string;
  org: string;
  months: string[];
  items: BillingItem[];
}

export interface WorkflowFile {
  path: string;
  content: string;
}

export interface RepoSetup {
  requiredChecks: string[];
  requiredChecksSource: "rulesets" | "branch-protection" | "none" | "unavailable";
  /** null when it could not be determined from the API. */
  mergeQueue: boolean | null;
  notes: string[];
}

export interface Dataset {
  schemaVersion: 1;
  repo: RepoInfo;
  window: { since: string; until: string };
  collectedAt: string;
  runs: Run[];
  /** Jobs (latest attempt) by run id, for sampled runs and outlier runs. */
  jobs: Record<string, Job[]>;
  sampledRunIds: number[];
  outlierRunIds: number[];
  prs: PullRequest[];
  billing: Billing;
  workflows: WorkflowFile[];
  setup: RepoSetup;
  notes: string[];
}
