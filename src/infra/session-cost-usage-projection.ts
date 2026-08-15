import { createTimeZoneDayKeyFormatter } from "./format-time/format-datetime.js";
import {
  canUseUsageCostRollupForPartial,
  countUsableUsageCostRollups,
  getUsageCostStaleRollupFiles,
  latestUsageCostRollupScan,
  type UsageCostStoredRollup,
} from "./session-cost-usage-aggregation.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage-collection.js";
import { addRollupToCostUsageSummary } from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals as emptyTotals } from "./session-cost-usage-totals.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

const formatUtcDayKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

type UsageDayKeyFormatter = (date: Date) => string;

export const createUsageDayKeyFormatter = (dayBucket?: UsageDailyBucket): UsageDayKeyFormatter => {
  if (dayBucket?.mode === "utc-offset") {
    return (date) =>
      formatUtcDayKey(new Date(date.getTime() + dayBucket.utcOffsetMinutes * 60 * 1000));
  }
  const timeZone =
    dayBucket?.mode === "time-zone"
      ? dayBucket.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return createTimeZoneDayKeyFormatter(timeZone);
};

/**
 * Maximum window (in days) for which we will zero-fill missing calendar
 * days. Bounded ranges from the UI's range filter top out at 90 days for
 * the explicit picker and "All" is the wildcard escape hatch — anything
 * wider than this threshold is treated as an all-time / open-ended range
 * and falls back to sparse behavior (only days with activity), since a
 * dense series at that scale would produce tens of thousands of zero
 * buckets (e.g. a 1970-based startMs → ~20k entries) without any user
 * value. 366 days covers a full year + leap-day cushion.
 */
const MAX_ZERO_FILL_DAYS = 366;

/**
 * Parse a `YYYY-MM-DD` day key into its UTC calendar-day timestamp. The
 * timestamp is only used to enumerate calendar labels; usage timestamps stay
 * in their requested timezone bucket.
 */
const parseDayKeyToUtcMs = (dayKey: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  const day = Number(match[3]);
  const dayMs = Date.UTC(year, monthIdx, day);
  const date = new Date(dayMs);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthIdx &&
    date.getUTCDate() === day
    ? dayMs
    : null;
};

/**
 * Ensure the daily map has an entry for every calendar day in [startMs, endMs].
 * Days without activity are inserted with a zero-valued totals bucket so the
 * resulting `daily` series matches the requested range length (one bar per
 * calendar day) instead of only covering days with recorded usage.
 *
 * Day keys must use the same calendar zone as the request range. Otherwise a
 * remote Gateway can return local-date labels for UTC/browser-local ranges,
 * which drops boundary usage when the UI compares calendar windows.
 */
const fillMissingDays = (
  dailyMap: Map<string, CostUsageTotals>,
  startMs: number,
  endMs: number,
  formatDayKey: UsageDayKeyFormatter,
): void => {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const startKey = formatDayKey(new Date(startMs));
  const endKey = formatDayKey(new Date(endMs));
  const startDayMs = parseDayKeyToUtcMs(startKey);
  const endDayMs = parseDayKeyToUtcMs(endKey);
  if (startDayMs === null || endDayMs === null) {
    // Defensive fallback — formatDayKey should always produce a YYYY-MM-DD
    // key, but if locale data ever shifts under us, at least make sure the
    // endpoint days are present so the chart isn't completely empty.
    if (!dailyMap.has(startKey)) {
      dailyMap.set(startKey, emptyTotals());
    }
    if (!dailyMap.has(endKey)) {
      dailyMap.set(endKey, emptyTotals());
    }
    return;
  }
  // Bound the fill by calendar labels, not elapsed milliseconds: DST days can
  // contain 23 or 25 hours. Wider ranges keep their sparse activity-only shape.
  const spanDays = Math.floor((endDayMs - startDayMs) / dayMs) + 1;
  if (spanDays > MAX_ZERO_FILL_DAYS) {
    return;
  }
  const maxIterations = MAX_ZERO_FILL_DAYS + 1;
  for (let cursorMs = startDayMs, i = 0; cursorMs <= endDayMs && i < maxIterations; i += 1) {
    const key = formatUtcDayKey(new Date(cursorMs));
    if (!dailyMap.has(key)) {
      dailyMap.set(key, emptyTotals());
    }
    cursorMs += dayMs;
  }
  if (!dailyMap.has(endKey)) {
    dailyMap.set(endKey, emptyTotals());
  }
};

const countCalendarDays = (
  startMs: number,
  endMs: number,
  formatDayKey: UsageDayKeyFormatter,
): number => {
  const startDayMs = parseDayKeyToUtcMs(formatDayKey(new Date(startMs)));
  const endDayMs = parseDayKeyToUtcMs(formatDayKey(new Date(endMs)));
  if (startDayMs === null || endDayMs === null || endDayMs < startDayMs) {
    return Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
  }
  return Math.floor((endDayMs - startDayMs) / (24 * 60 * 60 * 1000)) + 1;
};

export function buildCostUsageSummaryFromRollups(params: {
  rollups: Map<string, UsageCostStoredRollup>;
  files: UsageCostTranscriptFile[];
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  refreshing: boolean;
}): CostUsageSummary {
  const dailyMap = new Map<string, CostUsageTotals>();
  const totals = emptyTotals();
  const dayFormatter = createUsageDayKeyFormatter(params.dayBucket);
  const staleFiles = getUsageCostStaleRollupFiles(params);
  const cachedFiles = countUsableUsageCostRollups(params);
  for (const file of params.files) {
    const stored = params.rollups.get(file.filePath);
    if (!canUseUsageCostRollupForPartial({ stored, file }) || !stored) {
      continue;
    }
    addRollupToCostUsageSummary({
      rollup: stored.entry.rollup,
      startMs: params.startMs,
      endMs: params.endMs,
      formatDay: dayFormatter,
      daily: dailyMap,
      totals,
    });
  }
  fillMissingDays(dailyMap, params.startMs, params.endMs, dayFormatter);
  const status = params.refreshing
    ? "refreshing"
    : staleFiles.length > 0
      ? cachedFiles > 0
        ? "partial"
        : "stale"
      : "fresh";
  return {
    updatedAt: Date.now(),
    days: countCalendarDays(params.startMs, params.endMs, dayFormatter),
    daily: Array.from(dailyMap.entries())
      .map(([date, bucket]) => Object.assign({ date }, bucket))
      .toSorted((a, b) => a.date.localeCompare(b.date)),
    totals,
    cacheStatus: {
      status,
      cachedFiles,
      pendingFiles: staleFiles.length,
      staleFiles: staleFiles.length,
      refreshedAt: latestUsageCostRollupScan(params.rollups),
    },
  };
}
