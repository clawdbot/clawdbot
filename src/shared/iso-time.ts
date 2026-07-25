const ISO_ABSOLUTE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** Checks the calendar components of the ISO-like forms accepted by existing callers. */
export function hasValidIsoCalendarComponents(raw: string): boolean {
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
  const hasZeroFraction = !fractionRaw || !/[1-9]/.test(fractionRaw);
  const isEndOfDay = hour === 24 && minute === 0 && second === 0 && hasZeroFraction;

  // Date.parse rolls invalid calendar components forward, so validate them independently.
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
