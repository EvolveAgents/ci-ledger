import type { Config } from "../config.js";
import { parseWorkflow, workflowGroup, jobMatchesCheck, agentFor, type WorkflowInfo } from "../model/classify.js";
import { estimateBillable, compareWithBilling, type Estimate, type BillingComparison } from "../model/cost.js";
import { linkRuns, type LinkResult } from "../model/link.js";
import { planSample, wallMinutes } from "../model/strata.js";
import type { Dataset, PullRequest, Run } from "../types.js";

/** Everything derived once from a dataset and shared by the metric sections. */
export interface Context {
  data: Dataset;
  config: Config;
  now: Date;
  link: LinkResult;
  estimate: Estimate;
  comparison: BillingComparison;
  /** Estimated billable minutes per run: its stratum share, or exact for outliers. Unsampled strata and uncosted outliers are absent. */
  perRunBillable: Map<number, number>;
  wall: Map<number, number>;
  workflowInfo: Map<string, WorkflowInfo>;
  /** Group per workflow path. */
  groups: Map<string, string>;
  requiredPaths: Set<string>;
  prs: Map<number, PullRequest>;
  agentOf: Map<number, string>;
  runsByPr: Map<number, Run[]>;
}

export const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);

export function buildContext(data: Dataset, config: Config, now: Date): Context {
  const link = linkRuns(data.runs, data.prs, now);
  const estimate = estimateBillable(data, config);
  const comparison = compareWithBilling(estimate, data.billing, data);
  const wall = new Map<number, number>();
  for (const r of data.runs) {
    const m = wallMinutes(r);
    if (m !== null) wall.set(r.id, m);
  }

  const perRunBillable = new Map<number, number>();
  // Per-run share of each stratum's (rounded) estimate, so per-run figures add up to the totals exactly.
  const meanByStratum = new Map(estimate.strata.map((s) => [s.stratum, s.estimatedBillable / s.runs]));
  const plan = planSample(data.runs, { ...config.sampling, outlierMinutes: config.outlierMinutes });
  for (const [stratum, ids] of plan.strata) {
    const mean = meanByStratum.get(stratum);
    if (mean !== undefined) for (const id of ids) perRunBillable.set(id, mean);
  }
  for (const o of estimate.outliers.runs) if (o.billable !== null) perRunBillable.set(o.id, o.billable);

  const workflowInfo = new Map(data.workflows.map((w) => [w.path, parseWorkflow(w)]));
  const requiredPaths = new Set<string>();
  const runsById = new Map(data.runs.map((r) => [r.id, r]));
  for (const [id, jobs] of Object.entries(data.jobs)) {
    const run = runsById.get(Number(id));
    if (run && jobs.some((j) => data.setup.requiredChecks.some((c) => jobMatchesCheck(j.name, c, run.name)))) requiredPaths.add(run.path);
  }
  for (const info of workflowInfo.values()) {
    if (info.jobs.some((j) => data.setup.requiredChecks.some((c) => jobMatchesCheck(j.name, c, info.name) || jobMatchesCheck(j.id, c, info.name)))) {
      requiredPaths.add(info.path);
    }
  }

  const eventsByPath = new Map<string, Set<string>>();
  const nameByPath = new Map<string, string>();
  for (const r of data.runs) {
    if (!eventsByPath.has(r.path)) eventsByPath.set(r.path, new Set());
    eventsByPath.get(r.path)!.add(r.event);
    nameByPath.set(r.path, r.name);
  }
  for (const info of workflowInfo.values()) if (!nameByPath.has(info.path)) nameByPath.set(info.path, info.name);
  const groups = new Map<string, string>();
  for (const [path, name] of nameByPath) {
    groups.set(path, workflowGroup({
      name,
      path,
      events: [...(eventsByPath.get(path) ?? [])],
      info: workflowInfo.get(path),
      hasRequiredCheck: requiredPaths.has(path),
    }, config.workflowGroups));
  }

  const prs = new Map(data.prs.map((p) => [p.number, p]));
  const agentOf = new Map(data.prs.map((p) => [p.number, agentFor(p, config)]));
  const runsByPr = new Map<number, Run[]>();
  for (const r of data.runs) {
    const n = link.prByRun.get(r.id);
    if (n === undefined) continue;
    const list = runsByPr.get(n);
    if (list) list.push(r);
    else runsByPr.set(n, [r]);
  }
  return { data, config, now, link, estimate, comparison, perRunBillable, wall, workflowInfo, groups, requiredPaths, prs, agentOf, runsByPr };
}

export function billableOf(ctx: Context, runs: Iterable<Run>): number {
  let total = 0;
  for (const r of runs) total += ctx.perRunBillable.get(r.id) ?? 0;
  return total;
}

export function wallOf(ctx: Context, runs: Iterable<Run>): number {
  let total = 0;
  for (const r of runs) total += ctx.wall.get(r.id) ?? 0;
  return total;
}
