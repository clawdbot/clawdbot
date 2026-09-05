// ISO forbids -000000; reject the spelling before Number discards its sign.
const ISO_ABSOLUTE_RE =
  /^(?!-000000)([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[Tt](?<hour>\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?<offset>[Zz]|[+-]\d{2}:?\d{2})?)?$/;

const GREGORIAN_CYCLE_MS = 146_097 * 86_400_000;

/** Recognizes offsetless date and datetime forms from the shared ISO grammar. */
export function isOffsetlessIsoDateTime(raw: string): boolean {
  const match = ISO_ABSOLUTE_RE.exec(raw);
  return match !== null && match.groups?.offset === undefined;
}

/** Makes offsetless ISO dates and datetimes explicit UTC, preserving explicit offsets. */
export function normalizeUtcIso(raw: string): string {
  const match = ISO_ABSOLUTE_RE.exec(raw);
  return match && match.groups?.offset === undefined
    ? `${raw}${match.groups?.hour === undefined ? "T00:00:00" : ""}Z`
    : raw;
}

/** Checks the calendar components of the ISO-like forms accepted by existing callers. */
export function hasValidIsoCalendarComponents(raw: string): boolean {
  return parseIsoCalendarTimeMs(raw) !== undefined;
}

/** Projects Gregorian fields without clipping wall time before its offset is applied. */
export function getUtcCalendarTimeMs(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  // Gregorian dates repeat every 400 years. Date setters preserve years 0–99;
  // restoring whole cycles numerically also preserves wall times outside Date.
  const yearInCycle = year % 400;
  const date = new Date(0);
  date.setUTCFullYear(yearInCycle, monthIndex, day);
  return (
    date.setUTCHours(hour, minute, second, millisecond) +
    ((year - yearInCycle) / 400) * GREGORIAN_CYCLE_MS
  );
}

/** Parses valid ISO calendar fields without applying an offset or clipping wall time. */
export function parseIsoCalendarTimeMs(raw: string): number | undefined {
  const match = ISO_ABSOLUTE_RE.exec(raw);
  if (!match) {
    return undefined;
  }

  const [
    ,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw = "0",
    minuteRaw = "0",
    secondRaw = "0",
    fractionRaw,
  ] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = fractionRaw ? Number(fractionRaw.slice(1, 4).padEnd(3, "0")) : 0;
  const hasZeroFraction = !fractionRaw || !/[1-9]/.test(fractionRaw);
  const isEndOfDay = hour === 24 && minute === 0 && second === 0 && hasZeroFraction;

  // Validate the authored calendar before 24:00 rollover, independently of
  // the final instant's Date range and any timezone offset.
  const yearInCycle = year % 400;
  const probe = new Date(
    getUtcCalendarTimeMs(
      yearInCycle,
      month - 1,
      day,
      isEndOfDay ? 0 : hour,
      minute,
      second,
      millisecond,
    ),
  );
  if (
    probe.getUTCFullYear() !== yearInCycle ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== (isEndOfDay ? 0 : hour) ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second ||
    probe.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }
  return getUtcCalendarTimeMs(year, month - 1, day, hour, minute, second, millisecond);
}
