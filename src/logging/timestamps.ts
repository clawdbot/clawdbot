export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
}

export type TimestampStyle = "short" | "medium" | "long";

export type FormatTimestampOptions = {
  style?: TimestampStyle;
  timeZone?: string;
};

function resolveEffectiveTimeZone(timeZone?: string): string {
  const explicit = timeZone ?? process.env.TZ;
  return explicit && isValidTimeZone(explicit)
    ? explicit
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatOffset(offsetRaw: string): string {
  return offsetRaw === "GMT" ? "+00:00" : offsetRaw.slice(3);
}

function getTimestampParts(date: Date, timeZone?: string) {
  const fmt = new Intl.DateTimeFormat("en", {
    timeZone: resolveEffectiveTimeZone(timeZone),
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
