/**
 * Serves a synthetic World through the same REST and GraphQL endpoints the collector calls, in the
 * same response shapes, so `--fixture` mode exercises the real collector with no network.
 */
import type { FetchLike } from "../github/client.js";
import type { World, WEvent, WPr } from "./synthetic.js";

export interface FakeOptions {
  /** Reject GraphQL with 403, as some tokens and proxies do. */
  graphql?: boolean;
  /** Reject billing with 403, as for tokens that are not an org owner's. */
  billing?: boolean;
  /** Results cap of filtered run listings (GitHub's is 1,000). */
  cap?: number;
}

const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
const fail = (status: number, message: string) => new Response(JSON.stringify({ message }), { status });

function paginate<T>(url: URL, items: T[], wrap?: (page: T[], total: number) => unknown): Response {
  const per = Number(url.searchParams.get("per_page") ?? "30");
  const page = Number(url.searchParams.get("page") ?? "1");
  const slice = items.slice((page - 1) * per, page * per);
  const headers: Record<string, string> = {};
  if (page * per < items.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return json(wrap ? wrap(slice, items.length) : slice, headers);
}

function createdRange(value: string): [string, string] {
  const [a, b] = value.includes("..") ? value.split("..") : [value, value];
  const from = a!.length === 10 ? `${a}T00:00:00Z` : a!;
  const to = b!.length === 10 ? `${b}T23:59:59Z` : b!;
  return [from, to];
}

function gqlEvent(e: WEvent): Record<string, unknown> {
  switch (e.type) {
    case "queue_added": return { __typename: "AddedToMergeQueueEvent", createdAt: e.at };
    case "queue_removed": return { __typename: "RemovedFromMergeQueueEvent", createdAt: e.at, reason: e.reason };
    case "merged": return { __typename: "MergedEvent", createdAt: e.at };
    case "force_pushed": return { __typename: "HeadRefForcePushedEvent", createdAt: e.at };
    case "review_dismissed": return { __typename: "ReviewDismissedEvent", createdAt: e.at };
    case "review": return { __typename: "PullRequestReview", state: e.state, submittedAt: e.at, author: { login: e.author, __typename: e.bot ? "Bot" : "User" } };
    case "labeled": return { __typename: "LabeledEvent", createdAt: e.at, label: { name: e.label } };
    case "unlabeled": return { __typename: "UnlabeledEvent", createdAt: e.at, label: { name: e.label } };
    case "commit": return { __typename: "PullRequestCommit", commit: { oid: e.sha, messageHeadline: e.headline, committedDate: e.at } };
  }
}

function gqlPr(pr: WPr) {
  return {
    id: `PR_${pr.number}`, number: pr.number, state: pr.state.toUpperCase(), isDraft: pr.draft,
    createdAt: pr.created_at, updatedAt: pr.updated_at, closedAt: pr.closed_at, mergedAt: pr.merged_at,
    baseRefName: pr.base, headRefName: pr.head, headRefOid: pr.head_sha, additions: pr.additions, deletions: pr.deletions,
    author: { login: pr.author.login, __typename: pr.author.bot ? "Bot" : "User" },
    timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pr.events.map(gqlEvent) },
  };
}

function restUser(login: string, bot: boolean) {
  return { login: bot && !login.endsWith("[bot]") ? `${login}[bot]` : login, type: bot ? "Bot" : "User" };
}

export function fakeGitHub(world: World, options: FakeOptions = {}): FetchLike {
  const { owner, name } = world.repo;
  const base = `/repos/${owner}/${name}`;
  const prsByNumber = new Map(world.prs.map((p) => [p.number, p]));
  const runsById = new Map(world.runs.map((r) => [r.id, r]));
  const cap = options.cap ?? 1000;

  return async (input, init) => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname);
    const method = init?.method ?? "GET";

    if (method === "POST" && path === "/graphql") {
      if (options.graphql === false) return fail(403, "GraphQL is disabled for this token");
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("mergeQueue(")) return json({ data: { repository: { mergeQueue: world.mergeQueue ? { id: "MQ_1" } : null } } });
      if (query.includes("node(id:")) return json({ data: { node: { timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
      const repository: Record<string, unknown> = {};
      for (const m of query.matchAll(/p(\d+):pullRequest\(number:(\d+)\)/g)) {
        const pr = prsByNumber.get(Number(m[2]));
        repository[`p${m[1]}`] = pr ? gqlPr(pr) : null;
      }
      return json({ data: { repository } });
    }

    if (path === base) return json({ id: world.repo.id, name, full_name: `${owner}/${name}`, private: world.repo.private, default_branch: world.repo.default_branch, owner: { login: owner } });

    if (path === `${base}/actions/runs`) {
      const [from, to] = createdRange(url.searchParams.get("created") ?? "1970-01-01..2999-12-31");
      const matching = world.runs.filter((r) => r.created_at >= from && r.created_at <= to).slice(0, cap);
      return paginate(url, matching.map(({ jobs: _jobs, earlierAttemptMinutes: _e, ...run }) => run), (page, total) => ({ total_count: total, workflow_runs: page }));
    }
    const jobsMatch = path.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (jobsMatch) {
      const run = runsById.get(Number(jobsMatch[1]));
      return run ? paginate(url, run.jobs, (page, total) => ({ total_count: total, jobs: page })) : fail(404, "Not Found");
    }

    if (path === `${base}/pulls`) {
      const state = url.searchParams.get("state") ?? "open";
      const list = world.prs
        .filter((p) => state === "all" || (state === "open" ? p.state === "open" : p.state !== "open"))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((p) => ({ number: p.number, updated_at: p.updated_at, state: p.state === "open" ? "open" : "closed" }));
      return paginate(url, list);
    }
    const prMatch = path.match(/\/(pulls|issues)\/(\d+)(?:\/(\w+))?$/);
    if (prMatch) {
      const pr = prsByNumber.get(Number(prMatch[2]));
      if (!pr) return fail(404, "Not Found");
      const sub = prMatch[3];
      if (prMatch[1] === "pulls" && !sub) {
        return json({ number: pr.number, state: pr.state === "open" ? "open" : "closed", draft: pr.draft, created_at: pr.created_at,
          updated_at: pr.updated_at, closed_at: pr.closed_at, merged_at: pr.merged_at, base: { ref: pr.base },
          head: { ref: pr.head, sha: pr.head_sha }, additions: pr.additions, deletions: pr.deletions, user: restUser(pr.author.login, pr.author.bot) });
      }
      if (sub === "timeline") {
        const names: Record<string, string> = { queue_added: "added_to_merge_queue", queue_removed: "removed_from_merge_queue", merged: "merged",
          force_pushed: "head_ref_force_pushed", review_dismissed: "review_dismissed", labeled: "labeled", unlabeled: "unlabeled" };
        const events = pr.events.filter((e) => names[e.type]).map((e) => ({ event: names[e.type], created_at: e.at, ...("label" in e ? { label: { name: e.label } } : {}) }));
        return paginate(url, events);
      }
      if (sub === "commits") {
        return paginate(url, pr.events.flatMap((e) => (e.type === "commit" ? [{ sha: e.sha, commit: { message: `${e.headline}\n`, committer: { date: e.at } } }] : [])));
      }
      if (sub === "reviews") {
        return paginate(url, pr.events.flatMap((e) => (e.type === "review" ? [{ state: e.state, submitted_at: e.at, user: restUser(e.author, e.bot) }] : [])));
      }
      if (sub === "files") return paginate(url, pr.files.map((filename) => ({ filename })));
      return fail(404, "Not Found");
    }
    const compare = path.match(/\/compare\/(.+)\.\.\.(.+)$/);
    if (compare) {
      const pr = world.prs.find((p) => p.head_sha === compare[2]);
      return json({ behind_by: pr?.behind_by ?? 0, ahead_by: 1 });
    }

    if (path === `${base}/contents/.github/workflows`) {
      return json(world.workflows.map((w) => ({ name: w.path.split("/").pop(), path: w.path, type: "file" })));
    }
    const file = world.workflows.find((w) => path === `${base}/contents/${w.path}`);
    if (file) return json({ encoding: "base64", content: Buffer.from(file.content).toString("base64") });

    if (path === `${base}/rules/branches/${world.repo.default_branch}`) {
      return json([
        { type: "required_status_checks", parameters: { required_status_checks: world.requiredChecks.map((context) => ({ context })) } },
        ...(world.mergeQueue ? [{ type: "merge_queue", parameters: {} }] : []),
      ]);
    }
    if (path === `/organizations/${owner}/settings/billing/usage`) {
      if (options.billing === false) return fail(403, "Must have admin rights to the organization");
      const month = `${url.searchParams.get("year")}-${String(url.searchParams.get("month")).padStart(2, "0")}`;
      return json({ usageItems: world.billing.filter((i) => i.date.startsWith(month)) });
    }
    return fail(404, "Not Found");
  };
}
