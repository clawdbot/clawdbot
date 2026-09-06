import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  getUtcCalendarTimeMs,
  isOffsetlessIsoDateTime,
  parseIsoCalendarTimeMs,
} from "../../shared/iso-time.js";

// Interpret local wall-clock ISO strings in an explicit IANA time zone.
export function parseOffsetlessIsoDateTimeInTimeZone(raw: string, timeZone: string): string | null {
  const naiveMs = isOffsetlessIsoDateTime(raw) ? parseIsoCalendarTimeMs(raw) : undefined;
  if (naiveMs === undefined) {
    return null;
  }
  try {
    // Probe both sides of the local day so non-hour DST folds use their first
    // real occurrence while nonexistent spring-forward times remain rejected.
    // At Date-range endpoints, one side of the probe window may be out of range.
    const matchingInstants = [-86_400_000, 0, 86_400_000]
      .map((shiftMs) => asDateTimestampMs(naiveMs + shiftMs))
      .filter((probeMs) => probeMs !== undefined)
      .map((probeMs) => naiveMs - (getZonedWallTimeMs(probeMs, timeZone) - probeMs))
      .filter(
        (candidateMs) =>
          asDateTimestampMs(candidateMs) !== undefined &&
          getZonedWallTimeMs(candidateMs, timeZone) === naiveMs,
      );
    return matchingInstants.length > 0
      ? new Date(Math.min(...matchingInstants)).toISOString()
      : null;
  } catch {
    return null;
  }
}

function getZonedWallTimeMs(utcMs: number, timeZone: string): number {
  const utcDate = new Date(utcMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcDate);
  const getNumericPart = (type: string) => {
    const part = parts.find((candidate) => candidate.type === type);
    return Number.parseInt(part?.value ?? "0", 10);
  };
  // Intl's era years are positive; ISO uses astronomical years (1 BC = 0).
  const eraYear = getNumericPart("year");
  const year = parts.find((part) => part.type === "era")?.value === "BC" ? 1 - eraYear : eraYear;
  return getUtcCalendarTimeMs(
    year,
    getNumericPart("month") - 1,
    getNumericPart("day"),
    getNumericPart("hour"),
    getNumericPart("minute"),
    getNumericPart("second"),
    utcDate.getUTCMilliseconds(),
  );
}
