import { parse } from "yaml";
import { NO_AGENT, OTHER_GROUP, type Config, type WorkflowGroupRule } from "../config.js";
import type { PullRequest, WorkflowFile } from "../types.js";

export function normalizeLogin(login: string): string {
  return login.replace(/\[bot\]$/i, "").toLowerCase();
}

export function isBot(login: string | null, flaggedBot: boolean, config: Pick<Config, "botReviewers">): boolean {
  if (!login) return false;
  if (flaggedBot || /\[bot\]$/i.test(login)) return true;
  const n = normalizeLogin(login);
  return config.botReviewers.some((b) => normalizeLogin(b) === n);
}

export function isHumanReviewer(login: string | null, flaggedBot: boolean, config: Pick<Config, "botReviewers" | "humanReviewers">): boolean {
  if (!login || isBot(login, flaggedBot, config)) return false;
  if (config.humanReviewers === null) return true;
  const n = normalizeLogin(login);
  return config.humanReviewers.some((h) => normalizeLogin(h) === n);
}

/** Agent from the head branch prefix first, then the PR author; NO_AGENT when neither matches. */
export function agentFor(pr: Pick<PullRequest, "headRef" | "author">, config: Pick<Config, "agents">): string {
  for (const rule of config.agents) {
    if (rule.branchPrefixes?.some((p) => pr.headRef.startsWith(p))) return rule.agent;
  }
  const author = pr.author ? normalizeLogin(pr.author) : null;
  for (const rule of config.agents) {
    if (author && rule.authors?.some((a) => normalizeLogin(a) === author)) return rule.agent;
  }
  return NO_AGENT;
}

export function sizeBucket(linesChanged: number): string {
  if (linesChanged < 100) return "<100";
  if (linesChanged < 300) return "100-299";
  if (linesChanged < 1200) return "300-1199";
  return "1200+";
}
export const SIZE_BUCKETS = ["<100", "100-299", "300-1199", "1200+"];

export interface JobInfo {
  id: string;
  name: string;
  runsOn: string[];
  needs: string[];
  steps: number;
  /** `run:` commands, whitespace-collapsed, one per line of each run block. */
  commands: string[];
  usesReusableWorkflow: boolean;
}

export interface WorkflowInfo {
  path: string;
  name: string;
  /** Trigger event to its activity types (null when the trigger lists none, meaning the defaults). */
  triggers: Record<string, string[] | null>;
  concurrency: { group: string; cancelInProgress: boolean | string } | null;
  jobs: JobInfo[];
  parseError?: string;
}

function asList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

function concurrencyOf(v: unknown): WorkflowInfo["concurrency"] {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return { group: v, cancelInProgress: false };
  const o = v as { group?: unknown; "cancel-in-progress"?: unknown };
  const c = o["cancel-in-progress"];
  return { group: String(o.group ?? ""), cancelInProgress: typeof c === "boolean" ? c : c === undefined ? false : String(c) };
}

/** Triggers, concurrency and job structure of a workflow file. Never throws; parse errors are recorded. */
export function parseWorkflow(file: WorkflowFile): WorkflowInfo {
  const info: WorkflowInfo = { path: file.path, name: file.path.split("/").pop() ?? file.path, triggers: {}, concurrency: null, jobs: [] };
  let doc: Record<string, unknown>;
  try {
    doc = (parse(file.content) ?? {}) as Record<string, unknown>;
  } catch (err) {
    info.parseError = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return info;
  }
  if (typeof doc.name === "string") info.name = doc.name;
  const on = doc.on ?? doc.true;
  if (typeof on === "string") info.triggers[on] = null;
  else if (Array.isArray(on)) for (const e of on) info.triggers[String(e)] = null;
  else if (on && typeof on === "object") {
    for (const [event, cfg] of Object.entries(on as Record<string, unknown>)) {
      const types = cfg && typeof cfg === "object" && "types" in cfg ? asList((cfg as { types: unknown }).types) : null;
      info.triggers[event] = types;
    }
  }
  info.concurrency = concurrencyOf(doc.concurrency);
  const jobs = (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;
  for (const [id, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object") continue;
    const steps = Array.isArray(job.steps) ? (job.steps as Array<Record<string, unknown>>) : [];
    const commands = steps
      .flatMap((s) => (typeof s.run === "string" ? s.run.split("\n") : []))
      .map((c) => c.trim().replace(/\s+/g, " "))
      .filter((c) => c && !c.startsWith("#"));
    info.jobs.push({
      id,
      name: typeof job.name === "string" ? job.name : id,
      runsOn: asList(job["runs-on"]),
      needs: asList(job.needs),
      steps: steps.length,
      commands,
      usesReusableWorkflow: typeof job.uses === "string",
    });
  }
  return info;
}

/** Whether a check-run name reported by a job satisfies a required check context. */
export function jobMatchesCheck(jobName: string, context: string, workflowName?: string): boolean {
  if (jobName === context) return true;
  if (jobName.startsWith(`${context} (`)) return true;
  return workflowName !== undefined && context === `${workflowName} / ${jobName}`;
}

export interface GroupInput {
  name: string;
  path: string;
  events: string[];
  info?: WorkflowInfo;
  hasRequiredCheck: boolean;
}

function ruleMatches(rule: WorkflowGroupRule, w: GroupInput): boolean {
  if (rule.name && new RegExp(rule.name, "i").test(w.name)) return true;
  if (rule.path && new RegExp(rule.path, "i").test(w.path)) return true;
  if (rule.events?.some((e) => w.events.includes(e))) return true;
  if (rule.requiredChecks && w.hasRequiredCheck) return true;
  if (rule.triggerTypes && w.info) {
    for (const event of ["pull_request", "pull_request_target"]) {
      const types = w.info.triggers[event];
      if (types?.some((t) => rule.triggerTypes!.includes(t))) return true;
    }
  }
  return false;
}

export function workflowGroup(w: GroupInput, rules: readonly WorkflowGroupRule[]): string {
  return rules.find((r) => ruleMatches(r, w))?.group ?? OTHER_GROUP;
}
