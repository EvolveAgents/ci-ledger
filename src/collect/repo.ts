import type { Cache } from "../cache.js";
import { GitHubError, type GitHubClient } from "../github/client.js";
import type { RepoInfo, RepoSetup, WorkflowFile } from "../types.js";

interface ApiRepo {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
}

export async function collectRepo(
  gh: GitHubClient,
  cache: Cache,
  owner: string,
  name: string,
  offline = false,
): Promise<RepoInfo> {
  const cached = cache.read<RepoInfo>("repo.json");
  if (offline) {
    if (!cached) throw new Error(`No cached data for ${owner}/${name} in ${cache.dir}; run without --from-cache first`);
    return cached;
  }
  const { data } = await gh.request<ApiRepo>(`/repos/${owner}/${name}`);
  const info: RepoInfo = {
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
  };
  cache.write("repo.json", info);
  return info;
}

/** `.github/workflows/*.yml|yaml` from the default branch. A repo without the directory has none. */
export async function collectWorkflows(
  gh: GitHubClient,
  cache: Cache,
  repo: RepoInfo,
  offline = false,
): Promise<WorkflowFile[]> {
  if (offline) return cache.read<WorkflowFile[]>("workflows.json") ?? [];
  const ref = encodeURIComponent(repo.defaultBranch);
  type Entry = { name: string; path: string; type: string };
  let entries: Entry[];
  try {
    ({ data: entries } = await gh.request<Entry[]>(`/repos/${repo.owner}/${repo.name}/contents/.github/workflows?ref=${ref}`));
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) entries = [];
    else throw err;
  }
  const files: WorkflowFile[] = [];
  for (const entry of entries.filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name))) {
    const { data } = await gh.request<{ content: string; encoding: string }>(
      `/repos/${repo.owner}/${repo.name}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
    );
    const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
    files.push({ path: entry.path, content });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  cache.write("workflows.json", files);
  return files;
}

interface ApiRule {
  type: string;
  parameters?: { required_status_checks?: Array<{ context: string }> };
}

/**
 * Required checks from rulesets (GET .../rules/branches/{branch}), falling back to classic branch
 * protection; merge queue from a `merge_queue` rule or, failing that, GraphQL `mergeQueue(branch:)`.
 */
export async function collectSetup(gh: GitHubClient, cache: Cache, repo: RepoInfo, offline = false): Promise<RepoSetup> {
  if (offline) {
    return (
      cache.read<RepoSetup>("setup.json") ?? {
        requiredChecks: [],
        requiredChecksSource: "unavailable",
        mergeQueue: null,
        notes: ["repository setup was not in the cache"],
      }
    );
  }
  const base = `/repos/${repo.owner}/${repo.name}`;
  const branch = encodeURIComponent(repo.defaultBranch);
  const notes: string[] = [];
  let requiredChecks: string[] = [];
  let source: RepoSetup["requiredChecksSource"] = "none";
  let mergeQueue: boolean | null = null;

  try {
    const rules = await gh.list<ApiRule>(`${base}/rules/branches/${branch}?per_page=100`);
    mergeQueue = rules.some((r) => r.type === "merge_queue");
    requiredChecks = rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters?.required_status_checks?.map((c) => c.context) ?? []);
    if (requiredChecks.length) source = "rulesets";
  } catch (err) {
    notes.push(`rulesets: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (source === "none") {
    try {
      const { data } = await gh.request<{ contexts?: string[]; checks?: Array<{ context: string }> }>(
        `${base}/branches/${branch}/protection/required_status_checks`,
      );
      requiredChecks = [...(data.contexts ?? []), ...(data.checks ?? []).map((c) => c.context)];
      if (requiredChecks.length) source = "branch-protection";
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) {
        // no classic protection on this branch
      } else {
        source = "unavailable";
        notes.push(`branch protection: ${err instanceof Error ? err.message : String(err)} (needs Administration: read)`);
      }
    }
  }

  if (!mergeQueue) {
    try {
      const data = await gh.graphql<{ repository: { mergeQueue: { id: string } | null } | null }>(
        "query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}",
        { owner: repo.owner, name: repo.name, branch: repo.defaultBranch },
      );
      mergeQueue = data.repository?.mergeQueue != null;
    } catch (err) {
      notes.push(`merge queue lookup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const setup: RepoSetup = { requiredChecks: [...new Set(requiredChecks)].sort(), requiredChecksSource: source, mergeQueue, notes };
  cache.write("setup.json", setup);
  return setup;
}
