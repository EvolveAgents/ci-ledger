import type { Config } from "../config.js";
import { toolVersion } from "../paths.js";
import type { Dataset } from "../types.js";
import { buildContext, type Context } from "./context.js";
import {
  billableSection,
  billingSection,
  ciPerPrSection,
  fanOutSection,
  requiredChecksSection,
  rollupsSection,
  windowSection,
  workflowFilesSection,
  workflowsSection,
} from "./core.js";

/** Bump the major version on breaking changes to metrics.json; findings and the report read it. */
export const METRICS_SCHEMA_VERSION = "1.0.0";

function sources(ctx: Context) {
  const { data } = ctx;
  const timelineSources = new Set(data.prs.map((p) => p.source));
  return {
    billing: data.billing.status === "ok" ? ("actual" as const) : ("unavailable" as const),
    billingReason: data.billing.reason ?? null,
    prTimelines: timelineSources.size === 0 ? "none" : timelineSources.size > 1 ? "mixed" : [...timelineSources][0]!,
    requiredChecks: data.setup.requiredChecksSource,
    sampledRuns: data.sampledRunIds.length,
    outlierRunsWithJobs: data.outlierRunIds.length,
    notes: [...data.notes, ...data.setup.notes],
  };
}

/** The page-one numbers: estimated billable minutes, billing actuals and the model error. */
function modelSection(ctx: Context) {
  const { estimate, comparison, config, data } = ctx;
  return {
    estimatedBillableMinutes: estimate.totals.billableMinutes,
    actualBillableMinutes: comparison.actualMinutes,
    errorPct: comparison.errorPct,
    confidence: comparison.confidence,
    confidenceReason: comparison.available
      ? `compared with billing usage for ${data.repo.fullName} in the window`
      : `runtime-based estimate only: ${comparison.reason ?? "billing unavailable"}`,
    estimatedUsd: estimate.totals.usd,
    actualGrossUsd: comparison.actualGrossUsd,
    actualNetUsd: comparison.actualNetUsd,
    roundingWasteMinutes: estimate.totals.roundingWasteMinutes,
    selfHostedMinutes: estimate.totals.selfHostedMinutes,
    unpricedMinutes: estimate.totals.unpricedMinutes,
    unsampledRuns: estimate.unsampled.runs,
    privateRepo: data.repo.private,
    currency: config.rates.currency,
    ratesEffective: config.rates.effective ?? null,
    rates: config.rates.runners.map((r) => ({ sku: r.sku, perMinute: r.perMinute })),
  };
}

export function buildMetrics(data: Dataset, config: Config, now = new Date()) {
  const ctx = buildContext(data, config, now);
  return {
    schema: "ci-ledger/metrics" as const,
    schemaVersion: METRICS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    tool: { name: "ci-ledger", version: toolVersion() },
    repo: data.repo,
    config: {
      outlierMinutes: config.outlierMinutes,
      staleDays: config.staleDays,
      shortJobSeconds: config.shortJobSeconds,
      sampling: config.sampling,
      billing: config.billing,
    },
    sources: sources(ctx),
    window: windowSection(ctx),
    model: modelSection(ctx),
    workflows: workflowsSection(ctx),
    workflowFiles: workflowFilesSection(ctx),
    requiredChecks: requiredChecksSection(ctx),
    fanOut: fanOutSection(ctx),
    ciPerPr: ciPerPrSection(ctx),
    rollups: rollupsSection(ctx),
    billing: billingSection(ctx),
    billable: billableSection(ctx),
  };
}

export type Metrics = ReturnType<typeof buildMetrics>;
