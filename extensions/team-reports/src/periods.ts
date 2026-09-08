import { z } from "zod";

export const DAY_MS = 86_400_000;
export const periodSchema = z.enum(["day", "week", "month"]);

export type Period = z.infer<typeof periodSchema>;

/** Report window. Day windows are UTC [00:00, 24:00); weeks are ISO weeks (Monday start); months are calendar months. */
export type PeriodDescriptor = {
  period: Period;
  /** "2026-08-20" | "2026-W34" | "2026-08" */
  key: string;
  sinceMs: number;
  untilMs: number;
  title: string;
};

function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDay(value: string): number {
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(ms) || dateKey(ms) !== value) {
    throw new Error(`Invalid UTC day: ${value}`);
  }
  return ms;
}

function weekStart(ms: number): number {
  const day = new Date(ms).getUTCDay();
  return parseDay(dateKey(ms)) - ((day + 6) % 7) * DAY_MS;
}

function weekKey(ms: number): string {
  const start = weekStart(ms);
  const year = new Date(start + 3 * DAY_MS).getUTCFullYear();
  const first = weekStart(parseDay(`${year}-01-04`));
  return `${year}-W${String(Math.round((start - first) / (7 * DAY_MS)) + 1).padStart(2, "0")}`;
}

export function describePeriod(period: Period, value: string | number | Date): PeriodDescriptor {
  let ms: number;
  if (typeof value === "string") {
    if (period === "week" && /^\d{4}-W\d{2}$/.test(value)) {
      const year = value.slice(0, 4);
      ms = weekStart(parseDay(`${year}-01-04`)) + (Number(value.slice(6)) - 1) * 7 * DAY_MS;
      if (weekKey(ms) !== value) {
        throw new Error(`Invalid ISO week: ${value}`);
      }
    } else if (period === "month" && /^\d{4}-\d{2}$/.test(value)) {
      ms = parseDay(`${value}-01`);
    } else {
      ms = parseDay(value);
    }
  } else {
    ms = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) {
      throw new Error("Invalid report date");
    }
  }
  if (period === "day") {
    const key = dateKey(ms);
    const sinceMs = parseDay(key);
    return { period, key, sinceMs, untilMs: sinceMs + DAY_MS, title: `Daily Report ${key}` };
  }
  if (period === "week") {
    const key = weekKey(ms);
    const sinceMs = weekStart(ms);
    return { period, key, sinceMs, untilMs: sinceMs + 7 * DAY_MS, title: `Weekly Report ${key}` };
  }
  const key = dateKey(ms).slice(0, 7);
  const sinceMs = parseDay(`${key}-01`);
  const next = new Date(sinceMs);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { period, key, sinceMs, untilMs: next.getTime(), title: `Monthly Report ${key}` };
}

export function periodDayKeys(period: PeriodDescriptor, nowMs = period.untilMs): string[] {
  const keys: string[] = [];
  const untilMs = Math.min(period.untilMs, nowMs);
  for (let ms = period.sinceMs; ms < untilMs; ms += DAY_MS) {
    keys.push(dateKey(ms));
  }
  return keys;
}
