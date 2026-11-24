import type { Cache } from "../cache.js";
import { GitHubError, mapLimit, type GitHubClient } from "../github/client.js";
import type { PullRequest, RepoInfo, TimelineEvent } from "../types.js";

const TIMELINE_TYPES = [
  "ADDED_TO_MERGE_QUEUE_EVENT",
  "REMOVED_FROM_MERGE_QUEUE_EVENT",
  "MERGED_EVENT",
  "HEAD_REF_FORCE_PUSHED_EVENT",
  "REVIEW_DISMISSED_EVENT",
  "PULL_REQUEST_REVIEW",
  "LABELED_EVENT",
  "UNLABELED_EVENT",
  "PULL_REQUEST_COMMIT",
].join(",");

const TIMELINE_NODES = `pageInfo{hasNextPage endCursor} nodes{__typename
 ...on AddedToMergeQueueEvent{createdAt}
 ...on RemovedFromMergeQueueEvent{createdAt reason}
 ...on MergedEvent{createdAt}
 ...on HeadRefForcePushedEvent{createdAt}
 ...on ReviewDismissedEvent{createdAt}
 ...on PullRequestReview{state submittedAt author{login __typename}}
 ...on LabeledEvent{createdAt label{name}}
 ...on UnlabeledEvent{createdAt label{name}}
 ...on PullRequestCommit{commit{oid messageHeadline committedDate}}}`;

const PR_FIELDS = `id number state isDraft createdAt updatedAt closedAt mergedAt baseRefName headRefName headRefOid
 additions deletions author{login __typename}
 timelineItems(first:100,itemTypes:[${TIMELINE_TYPES}]){${TIMELINE_NODES}}`;

interface GqlNode {
  __typename: string;
  createdAt?: string;
  reason?: string | null;
  state?: string;
  submittedAt?: string | null;
  author?: { login: string; __typename: string } | null;
  label?: { name: string };
  commit?: { oid: string; messageHeadline: string; committedDate: string };
}
interface GqlConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GqlNode[];
}
interface GqlPr {
  id: string;
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  author: { login: string; __typename: string } | null;
  timelineItems: GqlConnection;
}

export function mapGqlNode(n: GqlNode): TimelineEvent | null {
  switch (n.__typename) {
    case "AddedToMergeQueueEvent":
      return { type: "queue_added", at: n.createdAt! };
    case "RemovedFromMergeQueueEvent":
      return { type: "queue_removed", at: n.createdAt!, reason: n.reason ?? null };
    case "MergedEvent":
      return { type: "merged", at: n.createdAt! };
    case "HeadRefForcePushedEvent":
      return { type: "force_pushed", at: n.createdAt! };
    case "ReviewDismissedEvent":
      return { type: "review_dismissed", at: n.createdAt! };
    case "PullRequestReview":
      if (!n.submittedAt) return null;
      return {
        type: "review",
        at: n.submittedAt,
        state: n.state ?? "COMMENTED",
        author: n.author?.login ?? null,
        authorIsBot: n.author?.__typename === "Bot",
      };
    case "LabeledEvent":
    case "UnlabeledEvent":
      return { type: n.__typename === "LabeledEvent" ? "labeled" : "unlabeled", at: n.createdAt!, label: n.label?.name ?? "" };
    case "PullRequestCommit":
      return n.commit
        ? { type: "commit", at: n.commit.committedDate, sha: n.commit.oid, headline: n.commit.messageHeadline }
        : null;
    default:
      return null;
  }
}

export function mapGqlPr(p: GqlPr, nodes: GqlNode[]): PullRequest {
  return {
    number: p.number,
    state: p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "open" : "closed",
    draft: p.isDraft,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    closedAt: p.closedAt,
    mergedAt: p.mergedAt,
    baseRef: p.baseRefName,
    headRef: p.headRefName,
    headSha: p.headRefOid,
    additions: p.additions,
    deletions: p.deletions,
    author: p.author?.login ?? null,
    authorIsBot: p.author?.__typename === "Bot",
    timeline: sortTimeline(nodes.map(mapGqlNode).filter((e): e is TimelineEvent => e !== null)),
    source: "graphql",
  };
}

function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/** Fetches up to 10 PRs per GraphQL query using aliases, paging any timeline longer than 100 items. */
async function fetchGraphql(gh: GitHubClient, repo: RepoInfo, numbers: number[]): Promise<PullRequest[]> {
  const aliases = numbers.map((n) => `p${n}:pullRequest(number:${n}){${PR_FIELDS}}`).join("\n");
  const data = await gh.graphql<{ repository: Record<string, GqlPr | null> }>(
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${aliases}}}`,
    { owner: repo.owner, name: repo.name },
  );
  const out: PullRequest[] = [];
  for (const p of Object.values(data.repository)) {
    if (!p) continue;
    const nodes = [...p.timelineItems.nodes];
    let page = p.timelineItems.pageInfo;
    while (page.hasNextPage) {
      const more = await gh.graphql<{ node: { timelineItems: GqlConnection } }>(
        `query($id:ID!,$after:String){node(id:$id){...on PullRequest{timelineItems(first:100,after:$after,itemTypes:[${TIMELINE_TYPES}]){${TIMELINE_NODES}}}}}`,
        { id: p.id, after: page.endCursor },
      );
      nodes.push(...more.node.timelineItems.nodes);
      page = more.node.timelineItems.pageInfo;
    }
    out.push(mapGqlPr(p, nodes));
  }
  return out;
}

interface RestPr {
  number: number;
  state: "open" | "closed";
  draft?: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  additions?: number;
  deletions?: number;
  user: { login: string; type?: string } | null;
}
interface RestEvent {
  event: string;
  created_at?: string;
  reason?: string | null;
  label?: { name: string };
}

/** REST fallback for tokens or proxies that block GraphQL: pulls/{n}, issues/{n}/timeline, commits, reviews. */
async function fetchRest(gh: GitHubClient, repo: RepoInfo, n: number): Promise<PullRequest> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const { data: pr } = await gh.request<RestPr>(`${base}/pulls/${n}`);
  const events = await gh.list<RestEvent>(`${base}/issues/${n}/timeline?per_page=100`);
  const commits = await gh.list<{ sha: string; commit: { message: string; committer?: { date: string } } }>(
    `${base}/pulls/${n}/commits?per_page=100`,
  );
  const reviews = await gh.list<{ state: string; submitted_at?: string; user: { login: string; type?: string } | null }>(
    `${base}/pulls/${n}/reviews?per_page=100`,
  );
  const timeline: TimelineEvent[] = [];
  const simple: Record<string, TimelineEvent["type"]> = {
    added_to_merge_queue: "queue_added",
    merged: "merged",
    head_ref_force_pushed: "force_pushed",
    review_dismissed: "review_dismissed",
  };
  for (const e of events) {
    if (!e.created_at) continue;
    const type = simple[e.event];
    if (type) timeline.push({ type, at: e.created_at } as TimelineEvent);
    else if (e.event === "removed_from_merge_queue") timeline.push({ type: "queue_removed", at: e.created_at, reason: e.reason ?? null });
    else if (e.event === "labeled" || e.event === "unlabeled") timeline.push({ type: e.event, at: e.created_at, label: e.label?.name ?? "" });
  }
  for (const c of commits) {
    timeline.push({ type: "commit", at: c.commit.committer?.date ?? pr.created_at, sha: c.sha, headline: c.commit.message.split("\n")[0]! });
  }
  for (const r of reviews) {
    if (!r.submitted_at) continue;
    timeline.push({ type: "review", at: r.submitted_at, state: r.state, author: r.user?.login ?? null, authorIsBot: r.user?.type === "Bot" });
  }
  return {
    number: pr.number,
    state: pr.merged_at ? "merged" : pr.state,
    draft: pr.draft ?? false,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    mergedAt: pr.merged_at,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    author: pr.user?.login ?? null,
    authorIsBot: pr.user?.type === "Bot",
    timeline: sortTimeline(timeline),
    source: "rest",
  };
}

interface Listed {
  number: number;
  updatedAt: string;
}

/** PRs updated since the window start (sorted by update time), plus every open PR. */
export async function listPrs(gh: GitHubClient, repo: RepoInfo, since: string): Promise<Listed[]> {
  const base = `/repos/${repo.owner}/${repo.name}/pulls`;
  const found = new Map<number, string>();
  for await (const page of gh.pages<Array<{ number: number; updated_at: string }>>(
    `${base}?state=all&sort=updated&direction=desc&per_page=100`,
  )) {
    for (const p of page.data) if (p.updated_at >= since) found.set(p.number, p.updated_at);
    const last = page.data[page.data.length - 1];
    if (!last || last.updated_at < since) break;
  }
  for (const p of await gh.list<{ number: number; updated_at: string }>(`${base}?state=open&per_page=100`)) {
    found.set(p.number, p.updated_at);
  }
  return [...found].map(([number, updatedAt]) => ({ number, updatedAt })).sort((a, b) => a.number - b.number);
}

export interface PrOptions {
  offline?: boolean;
  /** Force REST even when GraphQL works. */
  rest?: boolean;
  staleDays?: number;
  now?: Date;
  log?: (message: string) => void;
}

export interface PrResult {
  prs: PullRequest[];
  source: "graphql" | "rest" | "mixed" | "cache";
  notes: string[];
}

export async function collectPrs(
  gh: GitHubClient,
  cache: Cache,
  repo: RepoInfo,
  window: { since: string; until: string },
  options: PrOptions = {},
): Promise<PrResult> {
  const notes: string[] = [];
  const log = options.log ?? (() => {});
  if (options.offline) {
    const index = cache.read<Listed[]>("prs/index.json") ?? [];
    const prs = index.map((l) => cache.read<PullRequest>(`prs/${l.number}.json`)).filter((p): p is PullRequest => !!p);
    if (prs.length < index.length) notes.push(`${index.length - prs.length} PRs listed in the cache have no details`);
    return { prs, source: "cache", notes };
  }
  const listed = await listPrs(gh, repo, `${window.since}T00:00:00Z`);
  cache.write("prs/index.json", listed);
  const stale = listed.filter((l) => cache.read<PullRequest>(`prs/${l.number}.json`)?.updatedAt !== l.updatedAt);
  log(`${listed.length} PRs in scope, ${stale.length} to fetch`);

  let mode: "graphql" | "rest" = options.rest ? "rest" : "graphql";
  const used = new Set<"graphql" | "rest">();
  let graphqlErrors = 0;
  for (let i = 0; i < stale.length; ) {
    const batch = stale.slice(i, i + (mode === "graphql" ? 10 : 4)).map((l) => l.number);
    let fetched: PullRequest[] | null = null;
    if (mode === "graphql") {
      try {
        fetched = await fetchGraphql(gh, repo, batch);
        used.add("graphql");
        graphqlErrors = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // An HTTP-level refusal (401/403/...) means GraphQL is blocked for this token or network: switch
        // for the rest of the run. A GraphQL-level error (HTTP 200 with errors) only costs this batch,
        // unless it keeps happening.
        const blocked = !(err instanceof GitHubError && err.status === 200) || ++graphqlErrors >= 3;
        notes.push(`GraphQL ${blocked ? "unavailable" : "error on one batch"} (${msg.slice(0, 120)}); used the REST timeline ${blocked ? "instead" : "for that batch"}`);
        if (blocked) {
          log("GraphQL failed; falling back to REST for PR timelines");
          mode = "rest";
          continue;
        }
      }
    }
    if (!fetched) {
      fetched = await mapLimit(batch, 4, (n) => fetchRest(gh, repo, n));
      used.add("rest");
    }
    for (const pr of fetched) cache.write(`prs/${pr.number}.json`, await enrich(gh, repo, pr, options));
    i += batch.length;
  }
  // Unchanged open PRs still drift behind their base; refresh behind-base counts for idle ones.
  const fresh = new Set(stale.map((l) => l.number));
  for (const l of listed) {
    if (fresh.has(l.number)) continue;
    const cached = cache.read<PullRequest>(`prs/${l.number}.json`);
    if (cached && isIdleOpen(cached, options)) cache.write(`prs/${l.number}.json`, await refreshBehind(gh, repo, cached));
  }
  const prs = listed.map((l) => cache.read<PullRequest>(`prs/${l.number}.json`)).filter((p): p is PullRequest => !!p);
  const source = used.size > 1 ? "mixed" : used.size === 1 ? [...used][0]! : mode;
  return { prs, source, notes };
}

function isIdleOpen(pr: PullRequest, options: PrOptions): boolean {
  const idleDays = ((options.now ?? new Date()).getTime() - Date.parse(pr.updatedAt)) / 86_400_000;
  return pr.state === "open" && idleDays >= (options.staleDays ?? 14);
}

async function refreshBehind(gh: GitHubClient, repo: RepoInfo, pr: PullRequest): Promise<PullRequest> {
  try {
    const { data } = await gh.request<{ behind_by: number }>(
      `/repos/${repo.owner}/${repo.name}/compare/${encodeURIComponent(pr.baseRef)}...${pr.headSha}?per_page=1`,
    );
    pr.behindBy = data.behind_by;
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    pr.behindBy = null;
  }
  return pr;
}

/** Adds changed files to PRs removed from the queue for a conflict, and behind-base counts to idle open PRs. */
async function enrich(gh: GitHubClient, repo: RepoInfo, pr: PullRequest, options: PrOptions): Promise<PullRequest> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const conflict = pr.timeline.some((e) => e.type === "queue_removed" && /conflict/i.test(e.reason ?? ""));
  if (conflict) {
    try {
      const files = await gh.list<{ filename: string }>(`${base}/pulls/${pr.number}/files?per_page=100`, undefined, 300);
      pr.files = files.map((f) => f.filename);
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
    }
  }
  return isIdleOpen(pr, options) ? refreshBehind(gh, repo, pr) : pr;
}
