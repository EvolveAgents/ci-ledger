import type { Cache } from "../cache.js";
import { GitHubError, type GitHubClient } from "../github/client.js";
import type { Billing, BillingItem } from "../types.js";
import { daysBetween, monthKey, todayUtc } from "../util/time.js";

interface ApiUsageItem {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  grossAmount: number;
  netAmount: number;
  repositoryName?: string | null;
}

interface MonthFile {
  month: string;
  final: boolean;
  items: BillingItem[];
}

export function mapUsageItem(api: ApiUsageItem): BillingItem {
  return {
    date: String(api.date).slice(0, 10),
    product: api.product,
    sku: api.sku,
    unitType: api.unitType,
    repositoryName: api.repositoryName ?? "",
    quantity: Number(api.quantity) || 0,
    grossAmount: Number(api.grossAmount) || 0,
    netAmount: Number(api.netAmount) || 0,
  };
}

export function monthsOf(window: { since: string; until: string }): string[] {
  return [...new Set(daysBetween(window.since, window.until).map((d) => monthKey(`${d}T00:00:00Z`)))];
}

/**
 * Actions usage items for every month the window touches (whole months, so month-to-date figures
 * work), from GET /organizations/{org}/settings/billing/usage?year=&month=, one cache
 * file per month (past months are final). Needs an org owner or billing manager. Any 4xx makes billing
 * "unavailable", and the cost model falls back to its runtime estimate at lower confidence.
 */
export async function collectBilling(
  gh: GitHubClient,
  cache: Cache,
  org: string,
  window: { since: string; until: string },
  options: { offline?: boolean; now?: Date } = {},
): Promise<Billing> {
  const months = monthsOf(window);
  const currentMonth = monthKey(`${todayUtc(options.now)}T00:00:00Z`);
  const items: BillingItem[] = [];
  for (const month of months) {
    const rel = `billing/${org}-${month}.json`;
    let file = cache.read<MonthFile>(rel);
    if (!file || (!file.final && !options.offline)) {
      if (options.offline) {
        const marker = cache.read<{ reason: string }>(`billing/${org}-unavailable.json`);
        return { status: "unavailable", reason: marker?.reason ?? "billing data is not in the cache", org, months, items: [] };
      }
      const [year, mm] = month.split("-");
      try {
        const { data } = await gh.request<{ usageItems?: ApiUsageItem[] }>(
          `/organizations/${encodeURIComponent(org)}/settings/billing/usage?year=${year}&month=${Number(mm)}`,
        );
        const mapped = (data.usageItems ?? []).map(mapUsageItem).filter((i) => i.product.toLowerCase() === "actions");
        file = { month, final: month < currentMonth, items: mapped };
        cache.write(rel, file);
      } catch (err) {
        if (err instanceof GitHubError && err.status >= 400 && err.status < 500) {
          const reason =
            err.status === 403 || err.status === 401
              ? `billing usage needs an org owner or billing manager token (HTTP ${err.status})`
              : `billing usage is not available for "${org}" (HTTP ${err.status})`;
          cache.write(`billing/${org}-unavailable.json`, { reason });
          return { status: "unavailable", reason, org, months, items: [] };
        }
        throw err;
      }
    }
    items.push(...file.items);
  }
  return { status: "ok", org, months, items };
}
