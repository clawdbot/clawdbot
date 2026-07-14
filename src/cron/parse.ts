/** Parses cron schedule timestamps from user-facing absolute time strings. */
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";

const ISO_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]/;
const ISO_ABSOLUTE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

function normalizeUtcIso(raw: string) {
  if (ISO_TZ_RE.test(raw)) {
    return raw;
  }
  if (ISO_DATE_RE.test(raw)) {
    return `${raw}T00:00:00Z`;
  }
  if (ISO_DATE_TIME_RE.test(raw)) {
    return `${raw}Z`;
  }
  return raw;
}

function isValidIsoAbsolute(raw: string) {
  const match = ISO_ABSOLUTE_RE.exec(raw);
  if (!match) {
    return false;
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
  const isEndOfDay = hour === 24 && minute === 0 && second === 0 && millisecond === 0;

  // Date.parse rolls invalid calendar dates; cron must reject them before scheduling.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(isEndOfDay ? 0 : hour, minute, second, millisecond);

  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === (isEndOfDay ? 0 : hour) &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second &&
    probe.getUTCMilliseconds() === millisecond
  );
}

/** Parses absolute cron timestamps from epoch milliseconds or ISO-like strings normalized to UTC. */
export function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const n = parseStrictPositiveInteger(raw);
    if (n !== undefined && Number.isFinite(new Date(n).getTime())) {
      return n;
    }
    return null;
  }
  if (!isValidIsoAbsolute(raw)) {
    return null;
  }
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
