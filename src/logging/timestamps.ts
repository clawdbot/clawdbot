const validTimeZoneCache = new Map<string, boolean>();
const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();
let hostTimeZone: string | undefined;

export function isValidTimeZone(tz: string): boolean {
  const cached = validTimeZoneCache.get(tz);
  if (cached !== undefined) {
    return cached;
  }
  let valid;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format();
    valid = true;
  } catch {
    valid = false;
  }
  validTimeZoneCache.set(tz, valid);
  return valid;
}

type TimestampStyle = "short" | "medium" | "long";

type FormatTimestampOptions = {
  style?: TimestampStyle;
  timeZone?: string;
};

function resolveEffectiveTimeZone(timeZone?: string): string {
  const explicit = timeZone ?? process.env.TZ;
  return explicit && isValidTimeZone(explicit)
    ? explicit
    : (hostTimeZone ??= Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function formatOffset(offsetRaw: string): string {
  return offsetRaw === "GMT" ? "+00:00" : offsetRaw.slice(3);
}

function getTimestampParts(date: Date, timeZone?: string) {
  const effectiveTimeZone = resolveEffectiveTimeZone(timeZone);
  let fmt = timestampFormatterCache.get(effectiveTimeZone);
  if (!fmt) {
    // Log timestamps are formatted on hot paths; Intl construction is much
    // costlier than formatToParts, while timezone rules remain process-stable.
    fmt = new Intl.DateTimeFormat("en", {
      timeZone: effectiveTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      fractionalSecondDigits: 3 as 1 | 2 | 3,
      timeZoneName: "longOffset",
    });
    timestampFormatterCache.set(effectiveTimeZone, fmt);
  }

  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    fractionalSecond: parts.fractionalSecond,
    offset: formatOffset(parts.timeZoneName ?? "GMT"),
  };
}

export function formatTimestamp(date: Date, options?: FormatTimestampOptions): string {
  const style = options?.style ?? "medium";
  const parts = getTimestampParts(date, options?.timeZone);

  switch (style) {
    case "short":
      return `${parts.hour}:${parts.minute}:${parts.second}${parts.offset}`;
    case "medium":
      return `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.offset}`;
    case "long":
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.offset}`;
  }
  throw new Error("Unsupported timestamp style");
}

/**
 * @deprecated Use formatTimestamp from "./timestamps.js" instead.
 * This function will be removed in a future version.
 */
export function formatLocalIsoWithOffset(now: Date, timeZone?: string): string {
  return formatTimestamp(now, { style: "long", timeZone });
}
