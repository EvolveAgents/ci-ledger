import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface ClientOptions {
  token?: string | null;
  fetch?: FetchLike;
  baseUrl?: string;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Longest wait for a primary rate-limit reset before giving up. */
  maxRateLimitWaitMs?: number;
}

export interface Page<T> {
  data: T;
  status: number;
  headers: Headers;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function nextLink(headers: Headers): string | null {
  const link = headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** Minimal GitHub REST + GraphQL client over global fetch, with pagination, retries and rate-limit waits. */
export class GitHubClient {
  readonly baseUrl: string;
  requests = 0;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRateLimitWaitMs: number;

  constructor(options: ClientOptions = {}) {
    this.token = options.token ?? null;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.log = options.log ?? (() => {});
    this.sleep = options.sleep ?? realSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 15 * 60_000;
  }

  get authenticated(): boolean {
    return this.token !== null;
  }

  async request<T>(pathOrUrl: string, init: { method?: string; body?: unknown } = {}): Promise<Page<T>> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const path = url.slice(this.baseUrl.length) || url;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ci-ledger",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        this.requests++;
        res = await this.fetchImpl(url, {
          method: init.method ?? "GET",
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      } catch (err) {
        if (attempt >= this.maxRetries) throw new GitHubError(`network error: ${String(err)}`, 0, path);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        return { data: (text ? JSON.parse(text) : null) as T, status: res.status, headers: res.headers };
      }
      const wait = this.retryDelay(res, attempt);
      if (wait !== null) {
        await res.text().catch(() => "");
        this.log(`GitHub ${res.status} on ${path}; retrying in ${Math.ceil(wait / 1000)}s`);
        await this.sleep(wait);
        continue;
      }
      const body = await res.text().catch(() => "");
      let message = body;
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? body;
      } catch {
        // keep raw body
      }
      throw new GitHubError(`GitHub ${res.status} on ${path}: ${message.slice(0, 300)}`, res.status, path);
    }
  }

  /** Milliseconds to wait before retrying, or null when the error is final. */
  private retryDelay(res: Response, attempt: number): number | null {
    if (attempt >= this.maxRetries) return null;
    if (res.status >= 500) return 1000 * 2 ** attempt;
    if (res.status !== 403 && res.status !== 429) return null;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (retryAfter > 0) return Math.min(retryAfter * 1000, this.maxRateLimitWaitMs);
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = Math.max(reset - Date.now(), 0) + 1000;
      if (wait > this.maxRateLimitWaitMs) return null;
      return wait;
    }
    return res.status === 429 ? 60_000 : null;
  }

  /** Yields each page, following `Link: rel="next"`. */
  async *pages<T>(path: string): AsyncGenerator<Page<T>> {
    let next: string | null = path;
    while (next) {
      const page: Page<T> = await this.request<T>(next);
      yield page;
      next = nextLink(page.headers);
    }
  }

  /** Collects a paginated list; `pick` extracts the items from a page (for wrapped lists such as workflow_runs). */
  async list<T, P = T[]>(path: string, pick?: (page: P) => T[], limit = Infinity): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.pages<P>(path)) {
      const items = pick ? pick(page.data) : (page.data as unknown as T[]);
      out.push(...items);
      if (out.length >= limit) break;
    }
    return out;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { data } = await this.request<{ data?: T; errors?: Array<{ message: string; type?: string }> }>("/graphql", {
      method: "POST",
      body: { query, variables },
    });
    if (data?.errors?.length) {
      throw new GitHubError(`GraphQL: ${data.errors.map((e) => e.message).join("; ")}`, 200, "/graphql");
    }
    if (!data?.data) throw new GitHubError("GraphQL: empty response", 200, "/graphql");
    return data.data;
  }
}

export interface TokenSource {
  token: string | null;
  source: "GITHUB_TOKEN" | "GH_TOKEN" | "gh auth token" | "none";
}

type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;
const execFileP = promisify(execFile) as unknown as (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

/** GITHUB_TOKEN, then GH_TOKEN, then `gh auth token` when the GitHub CLI is set up. */
export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  exec: Exec = (file, args) => execFileP(file, args, { timeout: 5000 }),
): Promise<TokenSource> {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: "GH_TOKEN" };
  try {
    const { stdout } = await exec("gh", ["auth", "token"]);
    const token = stdout.trim();
    if (token) return { token, source: "gh auth token" };
  } catch {
    // gh missing or not logged in
  }
  return { token: null, source: "none" };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
