/** Validates user-supplied one-shot cron timestamps before scheduling. */
import {
  asDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
 * Validates one-shot cron timestamps with a small past grace window and far-future cap.
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

  const referenceNowMs = asDateTimestampMs(nowMs) ?? asDateTimestampMs(Date.now()) ?? 0;
  const diffMs = atMs - referenceNowMs;

  // Allow a one-minute grace window so creation and validation races do not
  // reject freshly submitted one-shot jobs.
  if (diffMs < -ONE_MINUTE_MS) {
    const nowDate = resolveTimestampMsToIsoString(referenceNowMs);
    const atDate = resolveTimestampMsToIsoString(atMs);
    const minutesAgo = Math.floor(-diffMs / ONE_MINUTE_MS);
    return {
      ok: false,
      message: `schedule.at is in the past: ${atDate} (${minutesAgo} minutes ago). Current time: ${nowDate}`,
    };
  }

  // Bound far-future one-shot jobs so mistyped years do not persist forever.
  if (diffMs > TEN_YEARS_MS) {
    const atDate = resolveTimestampMsToIsoString(atMs);
    const yearsAhead = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
    return {
      ok: false,
      message: `schedule.at is too far in the future: ${atDate} (${yearsAhead} years ahead). Maximum allowed: 10 years`,
    };
  }

  return { ok: true };
}
