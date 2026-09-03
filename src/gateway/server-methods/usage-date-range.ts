import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createTimeZoneDayKeyFormatter,
  resolveTimezone,
  resolveTimeZoneDayStartMs,
} from "../../infra/format-time/format-datetime.js";
import type { UsageDailyBucket } from "../../infra/session-cost-usage.js";

export type DateRange = { startMs: number; endMs: number; includeUntimestamped?: boolean };
// Keep validation and parsed timestamps in one result so handlers cannot forward
// an invalid or backwards window to the usage loaders.
type DateRangeResolution = { ok: true; value: DateRange } | { ok: false; error: string };
// 100 years: callers requesting unbounded history should use `range: "all"`.
// Larger explicit day counts would overflow ECMAScript Date arithmetic and
// surface as a misleading "calendar day does not exist" error from the resolver.
const MAX_USAGE_DAYS = 366 * 100;
export type DateInterpretation =
  | { mode: "utc" | "gateway" }
  | { mode: "utc-offset"; utcOffsetMinutes: number }
  | { mode: "time-zone"; timeZone: string; formatDayKey: (date: Date) => string };
type DateInterpretationResolution =
  | { ok: true; value: DateInterpretation }
  | { ok: false; error: string };
type DateParts = { year: number; monthIndex: number; day: number };

const MAX_CONSECUTIVE_SKIPPED_TIME_ZONE_DAYS = 1;

const parseDateParts = (raw: unknown): DateParts | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return undefined;
  }
  // The regex only checks shape; Date.* silently rolls impossible calendar dates over
  // (e.g. 2026-02-30 -> 2026-03-02), so a typo'd day would return usage for the wrong day.
  // Reject parts that don't round-trip through a UTC probe (also catches the JS 2-digit-year remap).
  const probe = new Date(Date.UTC(year, monthIndex, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== monthIndex ||
    probe.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { year, monthIndex, day };
};

const shiftDateParts = (parts: DateParts, days: number): DateParts => {
  const shifted = new Date(Date.UTC(parts.year, parts.monthIndex, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
};

const datePartsToStartMs = (
  parts: DateParts,
  interpretation: DateInterpretation,
): number | undefined => {
  const { year, monthIndex, day } = parts;
  if (interpretation.mode === "gateway") {
    return new Date(year, monthIndex, day).getTime();
  }
  if (interpretation.mode === "time-zone") {
    return resolveTimeZoneDayStartMs(
      formatDateParts(year, monthIndex, day),
      interpretation.timeZone,
    );
  }
  if (interpretation.mode === "utc-offset") {
    return Date.UTC(year, monthIndex, day) - interpretation.utcOffsetMinutes * 60 * 1000;
  }
  return Date.UTC(year, monthIndex, day);
};

const datePartsToEndMs = (
  parts: DateParts,
  interpretation: DateInterpretation,
): number | undefined => {
  const lookaheadDays =
    interpretation.mode === "time-zone" ? 1 + MAX_CONSECUTIVE_SKIPPED_TIME_ZONE_DAYS : 1;
  // A 24-hour date-line transition can remove one civil date entirely. Range
  // resolution separately verifies the requested day; this only finds its end.
  for (let daysAhead = 1; daysAhead <= lookaheadDays; daysAhead += 1) {
    const nextDayStartMs = datePartsToStartMs(shiftDateParts(parts, daysAhead), interpretation);
    if (nextDayStartMs !== undefined) {
      return nextDayStartMs - 1;
    }
  }
  return undefined;
};

// usage.cost / sessions.usage accept optional startDate/endDate. parseDateParts returns
// undefined for both absent and invalid input, so an explicitly supplied but unparseable
// date (bad format or impossible calendar date like 2026-02-30) would otherwise silently
// fall through to the default range and return a successful response for an unrelated range.
// Return the offending field so range resolution can reject it instead of querying the wrong window.
const findInvalidExplicitDate = (params: {
  startDate?: unknown;
  endDate?: unknown;
}): "startDate" | "endDate" | undefined => {
  for (const field of ["startDate", "endDate"] as const) {
    const raw = params[field];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
      continue;
    }
    if (parseDateParts(raw) === undefined) {
      return field;
    }
  }
  return undefined;
};

/**
 * Parse a UTC offset string in the format UTC+H, UTC-H, UTC+HH, UTC-HH, UTC+H:MM, UTC-HH:MM.
 * Returns the UTC offset in minutes (east-positive), or undefined if invalid.
 */
const parseUtcOffsetToMinutes = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^UTC([+-])(\d{1,2})(?::([0-5]\d))?$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  const totalMinutes = sign * (hours * 60 + minutes);
  if (totalMinutes < -12 * 60 || totalMinutes > 14 * 60) {
    return undefined;
  }
  return totalMinutes;
};

export const resolveDateInterpretation = (params: {
  mode?: unknown;
  utcOffset?: unknown;
  timeZone?: unknown;
}): DateInterpretationResolution => {
  if (params.mode === "gateway") {
    return { ok: true, value: { mode: "gateway" } };
  }
  if (params.mode === "specific") {
    const utcOffsetMinutes = parseUtcOffsetToMinutes(params.utcOffset);
    if (params.timeZone !== undefined && params.timeZone !== null) {
      const requestedTimeZone = normalizeOptionalString(params.timeZone);
      const timeZone = requestedTimeZone ? resolveTimezone(requestedTimeZone) : undefined;
      if (!timeZone) {
        // Browser tzdata can lead Gateway ICU. Preserve legacy fixed-offset
        // reporting when the concurrently supplied offset is still usable.
        if (utcOffsetMinutes !== undefined) {
          return { ok: true, value: { mode: "utc-offset", utcOffsetMinutes } };
        }
        return { ok: false, error: "invalid timeZone: expected a valid IANA time zone" };
      }
      return {
        ok: true,
        value: {
          mode: "time-zone",
          timeZone,
          formatDayKey: createTimeZoneDayKeyFormatter(timeZone),
        },
      };
    }
    if (utcOffsetMinutes !== undefined) {
      return { ok: true, value: { mode: "utc-offset", utcOffsetMinutes } };
    }
    // Only omission or blank text requests UTC; malformed offsets must not select another day.
    if (
      params.utcOffset != null &&
      (typeof params.utcOffset !== "string" || params.utcOffset.trim() !== "")
    ) {
      return { ok: false, error: "invalid utcOffset: expected UTC-12:00 through UTC+14:00" };
    }
  }
  // Backward compatibility: when mode is missing (or invalid), keep current UTC interpretation.
  return { ok: true, value: { mode: "utc" } };
};

export const resolveDayBucket = (
  interpretation: DateInterpretation,
): UsageDailyBucket | undefined => {
  if (interpretation.mode === "gateway") {
    return undefined;
  }
  if (interpretation.mode === "time-zone") {
    return { mode: "time-zone", timeZone: interpretation.timeZone };
  }
  return {
    mode: "utc-offset",
    utcOffsetMinutes: interpretation.mode === "utc-offset" ? interpretation.utcOffsetMinutes : 0,
  };
};

const getDateParts = (date: Date, interpretation: DateInterpretation): DateParts => {
  if (interpretation.mode === "gateway") {
    return { year: date.getFullYear(), monthIndex: date.getMonth(), day: date.getDate() };
  }
  if (interpretation.mode === "time-zone") {
    const parts = parseDateParts(interpretation.formatDayKey(date));
    if (!parts) {
      throw new Error("timezone formatter returned an invalid calendar day");
    }
    return parts;
  }
  if (interpretation.mode === "utc-offset") {
    const shifted = new Date(date.getTime() + interpretation.utcOffsetMinutes * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      monthIndex: shifted.getUTCMonth(),
      day: shifted.getUTCDate(),
    };
  }
  return {
    year: date.getUTCFullYear(),
    monthIndex: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
};

export const formatDateLabel = (ms: number, interpretation: DateInterpretation): string => {
  const parts = getDateParts(new Date(ms), interpretation);
  return formatDateParts(parts.year, parts.monthIndex, parts.day);
};

const formatDateParts = (year: number, monthIndex: number, day: number): string =>
  `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const parseDays = (raw: unknown): number | undefined => {
  const fromFinite = (n: number): number | undefined => {
    if (!Number.isFinite(n)) {
      return undefined;
    }
    return Math.min(Math.floor(n), MAX_USAGE_DAYS);
  };
  if (typeof raw === "number") {
    return fromFinite(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return fromFinite(Number(raw));
  }
  return undefined;
};

const resolveRangeDays = (raw: unknown): number | "all" | undefined => {
  if (raw === "all") {
    return "all";
  }
  if (raw === "7d") {
    return 7;
  }
  if (raw === "30d") {
    return 30;
  }
  if (raw === "90d") {
    return 90;
  }
  if (raw === "1y") {
    return 365;
  }
  return undefined;
};

const resolveTrailingDays = (
  endDateParts: DateParts,
  days: number,
  interpretation: DateInterpretation,
): DateRangeResolution => {
  const startMs = datePartsToStartMs(shiftDateParts(endDateParts, -(days - 1)), interpretation);
  const endMs = datePartsToEndMs(endDateParts, interpretation);
  if (startMs === undefined || endMs === undefined) {
    return { ok: false, error: "calendar day does not exist in requested time zone" };
  }
  return { ok: true, value: { startMs, endMs } };
};

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
export const resolveDateRange = (
  params: {
    startDate?: unknown;
    endDate?: unknown;
    days?: unknown;
    range?: unknown;
    mode?: unknown;
    utcOffset?: unknown;
    timeZone?: unknown;
  },
  resolvedInterpretation?: DateInterpretation,
): DateRangeResolution => {
  const invalidDate = findInvalidExplicitDate(params);
  if (invalidDate) {
    return {
      ok: false,
      error: `invalid ${invalidDate}: expected a valid YYYY-MM-DD calendar date`,
    };
  }

  const now = new Date();
  const interpretationResolution = resolvedInterpretation
    ? { ok: true as const, value: resolvedInterpretation }
    : resolveDateInterpretation(params);
  if (!interpretationResolution.ok) {
    return interpretationResolution;
  }
  const interpretation = interpretationResolution.value;
  const todayDateParts = getDateParts(now, interpretation);
  const todayEndMs = datePartsToEndMs(todayDateParts, interpretation);
  if (todayEndMs === undefined) {
    return { ok: false, error: "calendar day does not exist in requested time zone" };
  }

  const startDateParts = parseDateParts(params.startDate);
  const endDateParts = parseDateParts(params.endDate);
  // Explicit date windows are atomic. A single boundary must not silently
  // fall through to the unrelated default 30-day range.
  if ((startDateParts === undefined) !== (endDateParts === undefined)) {
    return { ok: false, error: "startDate and endDate must be provided together" };
  }

  if (startDateParts && endDateParts) {
    const startMs = datePartsToStartMs(startDateParts, interpretation);
    const endStartMs = datePartsToStartMs(endDateParts, interpretation);
    const endMs = datePartsToEndMs(endDateParts, interpretation);
    if (startMs === undefined || endStartMs === undefined || endMs === undefined) {
      return { ok: false, error: "calendar day does not exist in requested time zone" };
    }
    if (startMs > endStartMs) {
      return { ok: false, error: "startDate must not be after endDate" };
    }
    return { ok: true, value: { startMs, endMs } };
  }

  const rangeDays = resolveRangeDays(params.range);
  if (rangeDays === "all") {
    return {
      ok: true,
      value: { startMs: 0, endMs: todayEndMs, includeUntimestamped: true },
    };
  }
  if (rangeDays !== undefined) {
    return resolveTrailingDays(todayDateParts, rangeDays, interpretation);
  }

  const days = parseDays(params.days);
  if (days !== undefined) {
    const clampedDays = Math.max(1, days);
    return resolveTrailingDays(todayDateParts, clampedDays, interpretation);
  }

  // Default to last 30 days
  return resolveTrailingDays(todayDateParts, 30, interpretation);
};
