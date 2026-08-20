import { hasValidIsoCalendarComponents } from "../../shared/iso-time.js";

// Offsetless zoned datetime parsing interprets local wall-clock ISO strings in
// an explicit IANA time zone and rejects impossible DST times.
const OFFSETLESS_ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/;

type OffsetlessIsoDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

export function isOffsetlessIsoDateTime(raw: string): boolean {
  return OFFSETLESS_ISO_DATETIME_RE.test(raw);
}

export function parseOffsetlessIsoDateTimeInTimeZone(raw: string, timeZone: string): string | null {
  if (!isOffsetlessIsoDateTime(raw) || !hasValidIsoCalendarComponents(raw)) {
    return null;
  }
  try {
    const naiveDate = new Date(`${raw}${raw.length === 10 ? "T00:00:00" : ""}Z`);
    const naiveMs = naiveDate.getTime();
    if (Number.isNaN(naiveMs)) {
      return null;
    }

    // UTC Date rolls valid ISO 24:00 into the next local calendar day.
    const expectedParts: OffsetlessIsoDateTimeParts = {
      year: naiveDate.getUTCFullYear(),
      month: naiveDate.getUTCMonth() + 1,
      day: naiveDate.getUTCDate(),
      hour: naiveDate.getUTCHours(),
      minute: naiveDate.getUTCMinutes(),
      second: naiveDate.getUTCSeconds(),
      millisecond: naiveDate.getUTCMilliseconds(),
    };

    // Probe both sides of the local day so non-hour DST folds use their first
    // real occurrence while nonexistent spring-forward times remain rejected.
    const matchingInstants = [-86_400_000, 0, 86_400_000]
      .map((shiftMs) => naiveMs - getTimeZoneOffsetMs(naiveMs + shiftMs, timeZone))
      .filter((candidateMs) =>
        matchesOffsetlessIsoDateTimeParts(candidateMs, timeZone, expectedParts),
      );
    return matchingInstants.length > 0
      ? new Date(Math.min(...matchingInstants)).toISOString()
      : null;
  } catch {
    return null;
  }
}

function matchesOffsetlessIsoDateTimeParts(
  utcMs: number,
  timeZone: string,
  expected: OffsetlessIsoDateTimeParts,
): boolean {
  const actual = getZonedDateTimeParts(utcMs, timeZone);
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute &&
    actual.second === expected.second &&
    actual.millisecond === expected.millisecond
  );
}

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = getZonedDateTimeParts(utcMs, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    // Include the sub-second component (carried from utcMs via getUTCMilliseconds)
    // so the offset is exact. Dropping it makes the offset wrong by the fraction,
    // which fails the millisecond re-validation and rejects valid sub-second input.
    parts.millisecond,
  );

  return localAsUtc - utcMs;
}

function getZonedDateTimeParts(utcMs: number, timeZone: string): OffsetlessIsoDateTimeParts {
  const utcDate = new Date(utcMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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
  return {
    year: getNumericPart("year"),
    month: getNumericPart("month"),
    day: getNumericPart("day"),
    hour: getNumericPart("hour"),
    minute: getNumericPart("minute"),
    second: getNumericPart("second"),
    millisecond: utcDate.getUTCMilliseconds(),
  };
}
