import type { FetchLike } from "../../src/github/client.js";

export type Handler = (url: URL, body: unknown) => unknown;

/** A fetch stub keyed by "METHOD /path" (query string ignored). Handlers return JSON, or a Response for errors. */
export function routes(table: Record<string, Handler>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const key = `${init?.method ?? "GET"} ${decodeURIComponent(url.pathname)}`;
    calls.push(`${key}${url.search}`);
    const handler = table[key];
    if (!handler) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const out = handler(url, init?.body ? JSON.parse(String(init.body)) : undefined);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return Object.assign(fn, { calls });
}

export function status(code: number, message = "error"): Response {
  return new Response(JSON.stringify({ message }), { status: code });
}
