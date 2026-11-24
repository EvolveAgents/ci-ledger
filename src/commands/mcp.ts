import { parseArgs } from "node:util";
import type { Command } from "../cli.js";
import { serve } from "../mcp/server.js";
import { DEFAULT_OUT } from "./audit.js";

export const mcpCommand: Command = {
  name: "mcp",
  summary: "Serve the last audit's metrics and findings to MCP clients over stdio",
  usage: `Usage: ci-ledger mcp [--out dir]

Starts a Model Context Protocol server on stdin/stdout with the tools
get_summary, get_metric, list_findings and explain_finding. It reads
metrics.json and findings.json from --out (default: ${DEFAULT_OUT}) on each
call, so a new audit shows up without a restart. Local only; no network.

Claude Code: claude mcp add ci-ledger -- npx --yes ci-ledger mcp --out /path/to/ci-ledger-report`,
  async run(argv) {
    const { values } = parseArgs({ args: argv, options: { out: { type: "string", default: DEFAULT_OUT } } });
    await serve(values.out);
    return 0;
  },
};
