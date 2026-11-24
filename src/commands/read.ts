import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../cli.js";
import type { FindingsDoc } from "../findings/index.js";
import type { Metrics } from "../metrics/index.js";
import { explain, findingsSummary } from "../report/text.js";
import { DEFAULT_OUT } from "./audit.js";

export function loadOutputs(out: string): { findings: FindingsDoc; metrics?: Metrics } {
  const file = join(out, "findings.json");
  if (!existsSync(file)) throw new Error(`${file} not found; run \`ci-ledger audit\` first or pass --out`);
  const findings = JSON.parse(readFileSync(file, "utf8")) as FindingsDoc;
  const mfile = join(out, "metrics.json");
  const metrics = existsSync(mfile) ? (JSON.parse(readFileSync(mfile, "utf8")) as Metrics) : undefined;
  return { findings, metrics };
}

export const findingsCommand: Command = {
  name: "findings",
  summary: "Print the ranked findings from the last audit",
  usage: `Usage: ci-ledger findings [--out dir] [--json]\n\nReads findings.json (and metrics.json) from --out (default: ${DEFAULT_OUT}).`,
  async run(argv) {
    const { values } = parseArgs({ args: argv, options: { out: { type: "string", default: DEFAULT_OUT }, json: { type: "boolean", default: false } } });
    const { findings, metrics } = loadOutputs(values.out);
    console.log(values.json ? JSON.stringify(findings.findings, null, 2) : findingsSummary(findings, metrics));
    return 0;
  },
};

export const explainCommand: Command = {
  name: "explain",
  summary: "Explain one finding: evidence, savings basis and the fix",
  usage: `Usage: ci-ledger explain <finding-id | rule-id> [--out dir]\n\nA rule id lists all of its findings, or says why it found nothing.`,
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string", default: DEFAULT_OUT } } });
    const id = positionals[0];
    if (!id) throw new Error("pass a finding id, for example `ci-ledger explain rounding-waste`");
    const { findings, metrics } = loadOutputs(values.out);
    const text = explain(findings, id, metrics);
    if (!text) {
      console.error(`No finding or rule "${id}". Known ids:\n  ${findings.findings.map((f) => f.id).join("\n  ")}`);
      return 1;
    }
    console.log(text);
    return 0;
  },
};
