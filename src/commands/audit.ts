import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../cli.js";
import { collect } from "../collect/index.js";
import { loadConfig, resolveWindow } from "../config.js";
import { runFindings } from "../findings/index.js";
import { fakeGitHub } from "../fixtures/fake-github.js";
import { buildWorld } from "../fixtures/synthetic.js";
import { resolveToken } from "../github/client.js";
import { buildMetrics } from "../metrics/index.js";
import { findingsSummary } from "../report/text.js";

export const DEFAULT_OUT = "ci-ledger-report";
export const DEFAULT_CACHE = ".ci-ledger-cache";

const usage = `Usage: ci-ledger audit --repo owner/name [options]

Collects Actions runs, sampled jobs, PR timelines, billing and workflow files,
then writes metrics.json, findings.json and report.html.

Options:
  --repo owner/name   Repository to audit (required unless --fixture)
  --org name          Organization whose billing to read (default: repo owner)
  --since YYYY-MM-DD  Window start (default: 30 days before --until)
  --until YYYY-MM-DD  Window end (default: today, UTC)
  --out dir           Output directory (default: ${DEFAULT_OUT})
  --cache-dir dir     Cache directory (default: ${DEFAULT_CACHE})
  --from-cache        Read only from the cache; no network
  --fixture           Audit the built-in synthetic repository; no network or token
  --config file       Config file (default: ./ci-ledger.config.json if present)
  --no-billing        Skip the billing API
  --rest              Use REST instead of GraphQL for PR timelines
  --quiet             No progress output

Token: GITHUB_TOKEN, else GH_TOKEN, else \`gh auth token\`.`;

export async function runAudit(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      org: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      out: { type: "string", default: DEFAULT_OUT },
      "cache-dir": { type: "string", default: DEFAULT_CACHE },
      "from-cache": { type: "boolean", default: false },
      fixture: { type: "boolean", default: false },
      config: { type: "string" },
      "no-billing": { type: "boolean", default: false },
      rest: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
    },
    strict: true,
  });
  const log = values.quiet ? () => {} : (msg: string) => console.error(`[ci-ledger] ${msg}`);
  const config = loadConfig(values.config);

  let repo = values.repo;
  let window;
  let now = new Date();
  let fetch;
  let token: string | null = null;
  if (values.fixture) {
    const world = buildWorld();
    repo = `${world.repo.owner}/${world.repo.name}`;
    window = { since: values.since ?? world.since, until: values.until ?? world.until };
    now = world.now;
    fetch = fakeGitHub(world);
    token = "fixture";
    log("using the built-in synthetic repository (no network)");
  } else {
    if (!repo) throw new Error("--repo owner/name is required (or use --fixture)");
    window = resolveWindow(config, { since: values.since, until: values.until });
    if (!values["from-cache"]) {
      const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
      if (proxy && process.env.NODE_USE_ENV_PROXY !== "1") {
        log("HTTPS_PROXY is set, but Node's fetch ignores it unless NODE_USE_ENV_PROXY=1 is set; set it if requests must go through the proxy");
      }
      const t = await resolveToken();
      token = t.token;
      log(t.token ? `token from ${t.source}` : "no token found: unauthenticated requests are limited to 60 per hour");
    }
  }

  const data = await collect({
    repo,
    org: values.org,
    window,
    cacheDir: values["cache-dir"],
    config,
    offline: values["from-cache"],
    token,
    fetch,
    skipBilling: values["no-billing"],
    forceRest: values.rest,
    now,
    log,
  });
  const metrics = buildMetrics(data, config, now);
  const findings = runFindings(metrics, config, now);

  mkdirSync(values.out, { recursive: true });
  const write = (name: string, body: string) => {
    writeFileSync(join(values.out, name), body);
    return join(values.out, name);
  };
  const files = [write("metrics.json", `${JSON.stringify(metrics, null, 2)}\n`), write("findings.json", `${JSON.stringify(findings, null, 2)}\n`)];

  console.log(findingsSummary(findings, metrics));
  console.log(`\nWrote ${files.join(", ")}`);
  return 0;
}

export const auditCommand: Command = { name: "audit", summary: "Collect data and write metrics.json, findings.json and report.html", usage, run: runAudit };
