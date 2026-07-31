/**
 * Centralized date/time formatting utilities.
 *
 * All formatters are timezone-aware, using Intl.DateTimeFormat.
 * Consolidates duplicated formatUtcTimestamp / formatZonedTimestamp / resolveExplicitTimezone
 * that previously lived in envelope.ts and session-updates.ts.
 */
/**
 * Validate an IANA timezone string. Returns the string if valid, undefined otherwise.
 */
export function resolveTimezone(value: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return undefined;
  }
}

/** Build a stable YYYY-MM-DD formatter for instants in one IANA timezone. */
export function createTimeZoneDayKeyFormatter(timeZone: string): (date: Date) => string {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (date) => {
    const parts = formatter.formatToParts(date);
    const pick = (type: "year" | "month" | "day") =>
      parts.find((part) => part.type === type)?.value;
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    if (!year || !month || !day) {
      throw new Error("Intl.DateTimeFormat omitted required calendar-day parts");
    }
    return `${year.padStart(4, "0")}-${month}-${day}`;
  };
}

/** Resolve the first instant belonging to a calendar day in an IANA timezone. */
export function resolveTimeZoneDayStartMs(dayKey: string, timeZone: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return undefined;
  }
  const naiveUtcMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(naiveUtcMs)) {
    return undefined;
  }

  const formatDayKey = createTimeZoneDayKeyFormatter(timeZone);
  const searchWindowMs = 2 * 24 * 60 * 60 * 1000;
  let low = naiveUtcMs - searchWindowMs;
  let high = naiveUtcMs + searchWindowMs;
  // Calendar-day labels are monotonic across this bounded window. Find the
  // first millisecond whose local label is the requested day, including days
  // whose first wall-clock time is not 00:00 because of an offset transition.
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (formatDayKey(new Date(middle)) < dayKey) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return formatDayKey(new Date(low)) === dayKey ? low : undefined;
}

type FormatTimestampOptions = {
  /** Include seconds in the output. Default: false */
  displaySeconds?: boolean;
};

type FormatZonedTimestampOptions = FormatTimestampOptions & {
  /** IANA timezone string (e.g., 'America/New_York'). Default: system timezone */
  timeZone?: string;
};

/**
 * Format a Date as a UTC timestamp string.
 *
 * Without seconds: `2024-01-15T14:30Z`
 * With seconds:    `2024-01-15T14:30:05Z`
 */
export function formatUtcTimestamp(date: Date, options?: FormatTimestampOptions): string {
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  if (!options?.displaySeconds) {
    return `${yyyy}-${mm}-${dd}T${hh}:${min}Z`;
  }
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}Z`;
}

/**
 * Format a Date with timezone display using Intl.DateTimeFormat.
 *
 * Without seconds: `2024-01-15 14:30 EST`
 * With seconds:    `2024-01-15 14:30:05 EST`
 *
 * Returns undefined if Intl formatting fails.
 */
export function formatZonedTimestamp(
  date: Date,
  options?: FormatZonedTimestampOptions,
): string | undefined {
  try {
    const intlOptions: Intl.DateTimeFormatOptions = {
      timeZone: options?.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    };
    if (options?.displaySeconds) {
      intlOptions.second = "2-digit";
    }
    const parts = new Intl.DateTimeFormat("en-US", intlOptions).formatToParts(date);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value;
    const yyyy = pick("year");
    const mm = pick("month");
    const dd = pick("day");
    const hh = pick("hour");
    const min = pick("minute");
    const sec = options?.displaySeconds ? pick("second") : undefined;
    const tz = [...parts]
      .toReversed()
      .find((part) => part.type === "timeZoneName")
      ?.value?.trim();
    if (!yyyy || !mm || !dd || !hh || !min) {
      return undefined;
    }
    if (options?.displaySeconds && sec) {
      return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}${tz ? ` ${tz}` : ""}`;
    }
    return `${yyyy}-${mm}-${dd} ${hh}:${min}${tz ? ` ${tz}` : ""}`;
  } catch {
    return undefined;
  }
}
