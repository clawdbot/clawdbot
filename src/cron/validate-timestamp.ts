import { normalizeOptionalString } from "../shared/string-coerce.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import type { CronSchedule } from "./types.js";

const ONE_MINUTE_MS = 60 * 1000;
const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

type TimestampValidationError = {
  ok: false;
  message: string;
};

type TimestampValidationSuccess = {
  ok: true;
};

type TimestampValidationResult = TimestampValidationSuccess | TimestampValidationError;

/**
 * Validates at timestamps in cron schedules.
 * Rejects timestamps that are:
 * - More than 1 minute in the past
 * - More than 10 years in the future
 */
export function validateScheduleTimestamp(
  schedule: CronSchedule,
  nowMs: number = Date.now(),
): TimestampValidationResult {
  if (schedule.kind !== "at") {
    return { ok: true };
  }

  const atRaw = normalizeOptionalString(schedule.at) ?? "";
  const atMs = atRaw ? parseAbsoluteTimeMs(atRaw) : null;

  if (atMs === null || !Number.isFinite(atMs)) {
    return {
      ok: false,
      message: `Invalid schedule.at: expected ISO-8601 timestamp (got ${schedule.at})`,
    };
  }

  const diffMs = atMs - nowMs;

  // Check if timestamp is in the past (allow 1 minute grace period)
  if (diffMs < -ONE_MINUTE_MS) {
    const nowDate = new Date(nowMs).toISOString();
    const atDate = new Date(atMs).toISOString();
    const minutesAgo = Math.floor(-diffMs / ONE_MINUTE_MS);
    return {
      ok: false,
      message: `schedule.at is in the past: ${atDate} (${minutesAgo} minutes ago). Current time: ${nowDate}`,
    };
  }

  // Check if timestamp is too far in the future
  if (diffMs > TEN_YEARS_MS) {
    const atDate = new Date(atMs).toISOString();
    const yearsAhead = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
    return {
      ok: false,
      message: `schedule.at is too far in the future: ${atDate} (${yearsAhead} years ahead). Maximum allowed: 10 years`,
    };
  }

  return { ok: true };
}
