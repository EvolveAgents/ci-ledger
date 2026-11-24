const DAY_MS = 86_400_000;

export function toDate(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  return d;
}

/** YYYY-MM-DD in UTC. */
export function dayKey(date: Date | string): string {
  const d = typeof date === "string" ? toDate(date) : date;
  return d.toISOString().slice(0, 10);
}

export function monthKey(date: Date | string): string {
  return dayKey(date).slice(0, 7);
}

/** ISO-8601 week key such as 2026-W07 (weeks start on Monday, UTC). */
export function weekKey(date: Date | string): string {
  const d = typeof date === "string" ? toDate(date) : new Date(date.getTime());
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function addDays(day: string, n: number): string {
  return dayKey(new Date(toDate(`${day}T00:00:00Z`).getTime() + n * DAY_MS));
}

/** Inclusive list of YYYY-MM-DD days. */
export function daysBetween(since: string, until: string): string[] {
  const out: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
}

export function minutesBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ms = toDate(b).getTime() - toDate(a).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 60_000 : null;
}

export function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const m = minutesBetween(a, b);
  return m === null ? null : m / 60;
}

export function isValidDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function todayUtc(now = new Date()): string {
  return dayKey(now);
}
