/**
 * A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), tools only, reading the local
 * outputs of the last `ci-ledger audit`. Protocol revisions 2024-11-05 through 2025-11-25.
 * Nothing is written to stdout except protocol messages; diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { loadOutputs } from "../commands/read.js";
import { toolVersion } from "../paths.js";
import { explain, modelLine } from "../report/text.js";
import { resolvePath } from "../util/path.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MAX_TEXT = 60_000;

export const TOOLS = [
  {
    name: "get_summary",
    description: "Headline numbers from the last CI Ledger audit: window, estimated vs billed minutes, model error and confidence, runs, merged PRs, and savings totals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_metric",
    description:
      'Read a value from metrics.json by path, e.g. "model.errorPct", "workflows[0]", "mergeQueue.kickOutRate" or \'revisions.bySize["1200+"]\'. An empty path lists the top-level sections.',
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Dot path with [index] and [\"key\"] segments." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_findings",
    description: "Findings from the last audit, fixes ranked by minutes saved per 30 days, then reports; plus rules that were skipped or found nothing.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fix", "report"], description: "Only fixes or only reports." },
        limit: { type: "integer", minimum: 1, description: "At most this many findings." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "explain_finding",
    description: "Evidence (with metrics.json paths), savings basis, fix steps and YAML sketch for a finding id, or every finding of a rule id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: 'A finding id such as "rounding-waste:ci", or a rule id such as "rounding-waste".' } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

function text(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n... truncated (${s.length} characters); ask for a narrower path.` : s;
}

/** Runs one tool against the outputs in `out`. Errors become tool results with isError, per MCP. */
export function callTool(out: string, name: string, args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: text(v) }] });
  const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
  let outputs;
  try {
    outputs = loadOutputs(out);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const { findings, metrics } = outputs;
  switch (name) {
    case "get_summary":
      if (!metrics) return fail(`metrics.json not found in ${out}`);
      return ok({
        repo: metrics.repo.fullName,
        window: metrics.window,
        model: modelLine(metrics),
        confidence: metrics.model.confidence,
        totals: findings.totals,
        topFixes: findings.findings.filter((f) => f.kind === "fix").slice(0, 5).map((f) => ({ id: f.id, title: f.title, minutesPer30d: f.savings.minutesPer30d })),
      });
    case "get_metric": {
      if (!metrics) return fail(`metrics.json not found in ${out}`);
      const path = String(args.path ?? "").trim();
      if (!path) return ok(Object.keys(metrics));
      const value = resolvePath(metrics, path);
      return value === undefined ? fail(`No value at "${path}". Top-level sections: ${Object.keys(metrics).join(", ")}`) : ok(value);
    }
    case "list_findings": {
      const kind = args.kind === "fix" || args.kind === "report" ? args.kind : undefined;
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;
      const list = findings.findings.filter((f) => !kind || f.kind === kind).slice(0, limit);
      return ok({
        repo: findings.repo,
        window: findings.window,
        totals: findings.totals,
        findings: list.map((f) => ({ id: f.id, kind: f.kind, title: f.title, minutesPer30d: f.savings.minutesPer30d, usdPer30d: f.savings.usdPer30d, confidence: f.confidence, summary: f.summary })),
        skipped: findings.skipped,
        notTriggered: findings.notTriggered,
      });
    }
    case "explain_finding": {
      const id = String(args.id ?? "");
      const result = explain(findings, id, metrics);
      return result ? ok(result) : fail(`No finding or rule "${id}". Known ids: ${findings.findings.map((f) => f.id).join(", ")}`);
    }
    default:
      return fail(`Unknown tool "${name}"`);
  }
}

/** Handles one parsed message; returns the response to send, or null for notifications. */
export function handle(out: string, msg: Request): object | null {
  const id = msg.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return msg.id === undefined ? null : error(-32600, "Invalid Request");
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ci-ledger", version: toolVersion() },
        instructions: `Reads the outputs of the last \`ci-ledger audit\` in ${out}. Start with get_summary or list_findings; use explain_finding for the evidence and fix, and get_metric to look up any number by its metrics.json path.`,
      });
    }
    case "ping":
      return isNotification ? null : reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return error(-32602, `Unknown tool: ${name}`);
      return reply(callTool(out, name, (msg.params?.arguments as Record<string, unknown>) ?? {}));
    }
    default:
      return isNotification ? null : error(-32601, `Method not found: ${msg.method}`);
  }
}

export function serve(out: string, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const send = (m: object) => output.write(`${JSON.stringify(m)}\n`);
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    try {
      const res = handle(out, msg as Request);
      if (res) send(res);
    } catch (err) {
      send({ jsonrpc: "2.0", id: (msg as Request).id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  });
  return new Promise((resolve) => rl.on("close", resolve));
}
