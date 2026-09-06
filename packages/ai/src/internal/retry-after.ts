const HTTP_DATE_MONTH_INDEX = new Map(
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(
    (month, index) => [month, index],
  ),
);
const HTTP_DATE_SHORT_WEEKDAY_INDEX = new Map(
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday, index) => [weekday, index]),
);
const HTTP_DATE_LONG_WEEKDAY_INDEX = new Map(
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
    (weekday, index) => [weekday, index],
  ),
);

const IMF_FIXDATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const OBSOLETE_RFC850_DATE_RE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const OBSOLETE_ASCTIME_DATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

type HttpDateComponents = {
  weekday: number | undefined;
  year: number;
  month: number | undefined;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
};

type HttpDateInstant = {
  timestampMs: number;
  // Date cannot represent :60; its following timestamp is an exclusive upper bound.
  leapSecond: boolean;
};

function ownDataValue(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

/** Reads only retry timing metadata, without invoking provider getters or serialization hooks. */
export function parseRetryAfterHeadersSeconds(
  headers: unknown,
  nowMs = Date.now(),
): number | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  try {
    let entries: Array<[string, unknown]>;
    try {
      entries = ["retry-after", "retry-after-ms"].map<[string, unknown]>((key) => [
        key,
        Headers.prototype.get.call(headers, key),
      ]);
    } catch {
      entries = Object.getOwnPropertyNames(headers).flatMap<[string, unknown]>((key) => {
        const name = key.toLowerCase();
        return name === "retry-after" || name === "retry-after-ms"
          ? [[name, ownDataValue(headers, key)]]
          : [];
      });
    }
    let floor: number | undefined;
    for (const [key, value] of entries) {
      const text =
        typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
      const milliseconds = key === "retry-after-ms";
      const numeric =
        typeof value === "number"
          ? value >= 0 && (milliseconds || Number.isInteger(value) || value === Infinity)
          : (milliseconds ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(text);
      const number = typeof value === "number" ? value : Number(text);
      const retryAt =
        !numeric && !milliseconds ? parseRetryAfterHttpDateMs(text, nowMs) : undefined;
      const seconds = numeric
        ? Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER
          ? number / (milliseconds ? 1000 : 1)
          : Infinity
        : retryAt === undefined
          ? undefined
          : Math.max(0, (retryAt - nowMs) / 1000);
      if (seconds !== undefined) {
        floor = Math.max(floor ?? 0, seconds);
      }
    }
    return floor;
  } catch {
    return undefined;
  }
}

/** SDK errors carry native response headers separately from their error body. */
export function parseRetryAfterErrorSeconds(
  error: unknown,
  nowMs = Date.now(),
): number | undefined {
  try {
    const direct = parseRetryAfterHeadersSeconds(ownDataValue(error, "headers"), nowMs);
    const response = parseRetryAfterHeadersSeconds(
      ownDataValue(ownDataValue(error, "response"), "headers"),
      nowMs,
    );
    return direct === undefined && response === undefined
      ? undefined
      : Math.max(direct ?? 0, response ?? 0);
  } catch {
    return undefined;
  }
}

/** Round leap seconds forward for Retry-After so an unrepresentable instant cannot retry early. */
export function parseRetryAfterHttpDateMs(value: string, nowMs = Date.now()): number | undefined {
  return parseHttpDateInstant(value, nowMs)?.timestampMs;
}

/** Parse all three HTTP-date forms while retaining leap-second ordering. */
export function parseHttpDateInstant(
  value: string,
  nowMs = Date.now(),
): HttpDateInstant | undefined {
  const imfFixdate = IMF_FIXDATE_RE.exec(value);
  if (imfFixdate) {
    return parseHttpDateComponents({
      weekday: HTTP_DATE_SHORT_WEEKDAY_INDEX.get(imfFixdate[1] ?? ""),
      year: Number.parseInt(imfFixdate[4] ?? "", 10),
      month: HTTP_DATE_MONTH_INDEX.get(imfFixdate[3] ?? ""),
      day: Number.parseInt(imfFixdate[2] ?? "", 10),
      hours: Number.parseInt(imfFixdate[5] ?? "", 10),
      minutes: Number.parseInt(imfFixdate[6] ?? "", 10),
      seconds: Number.parseInt(imfFixdate[7] ?? "", 10),
    });
  }

  const rfc850Date = OBSOLETE_RFC850_DATE_RE.exec(value);
  if (rfc850Date) {
    const now = new Date(nowMs);
    if (Number.isNaN(now.getTime())) {
      return undefined;
    }
    const shortYear = Number.parseInt(rfc850Date[4] ?? "", 10);
    const candidateYear = Math.floor(now.getUTCFullYear() / 100) * 100 + shortYear;
    const components = {
      weekday: HTTP_DATE_LONG_WEEKDAY_INDEX.get(rfc850Date[1] ?? ""),
      month: HTTP_DATE_MONTH_INDEX.get(rfc850Date[3] ?? ""),
      day: Number.parseInt(rfc850Date[2] ?? "", 10),
      hours: Number.parseInt(rfc850Date[5] ?? "", 10),
      minutes: Number.parseInt(rfc850Date[6] ?? "", 10),
      seconds: Number.parseInt(rfc850Date[7] ?? "", 10),
    };
    const candidate = parseHttpDateCalendarMs({ year: candidateYear, ...components });
    if (candidate === undefined) {
      return undefined;
    }
    // RFC 9110 resolves two-digit years against the current century, then rolls
    // dates more than 50 years ahead back by 100 years.
    const fiftyYearsFromNow = Date.UTC(
      now.getUTCFullYear() + 50,
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    );
    const resolvedYear = candidate > fiftyYearsFromNow ? candidateYear - 100 : candidateYear;
    return parseHttpDateComponents({ year: resolvedYear, ...components });
  }

  const asctimeDate = OBSOLETE_ASCTIME_DATE_RE.exec(value);
  if (asctimeDate) {
    return parseHttpDateComponents({
      weekday: HTTP_DATE_SHORT_WEEKDAY_INDEX.get(asctimeDate[1] ?? ""),
      year: Number.parseInt(asctimeDate[7] ?? "", 10),
      month: HTTP_DATE_MONTH_INDEX.get(asctimeDate[2] ?? ""),
      day: Number.parseInt((asctimeDate[3] ?? "").trim(), 10),
      hours: Number.parseInt(asctimeDate[4] ?? "", 10),
      minutes: Number.parseInt(asctimeDate[5] ?? "", 10),
      seconds: Number.parseInt(asctimeDate[6] ?? "", 10),
    });
  }

  return undefined;
}

function parseHttpDateComponents(components: HttpDateComponents): HttpDateInstant | undefined {
  const timestamp = parseHttpDateCalendarMs(components);
  if (timestamp === undefined) {
    return undefined;
  }
  const leapSecond = components.seconds === 60;
  const weekdayTimestamp = leapSecond ? timestamp - 1_000 : timestamp;
  if (new Date(weekdayTimestamp).getUTCDay() !== components.weekday) {
    return undefined;
  }
  return { timestampMs: timestamp, leapSecond };
}

function parseHttpDateCalendarMs(
  components: Omit<HttpDateComponents, "weekday">,
): number | undefined {
  const { year, month, day, hours, minutes, seconds } = components;
  if (
    month === undefined ||
    !Number.isInteger(year) ||
    year < 1900 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hours) ||
    hours < 0 ||
    hours > 23 ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > 59 ||
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > 60
  ) {
    return undefined;
  }

  const calendarSecond = Math.min(seconds, 59);
  // JavaScript Date has no :60 representation. Validate the stated calendar
  // second against :59, then advance to the leap-second instant.
  const timestamp = Date.UTC(year, month, day, hours, minutes, calendarSecond);
  const parsedDate = new Date(timestamp);
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month ||
    parsedDate.getUTCDate() !== day ||
    parsedDate.getUTCHours() !== hours ||
    parsedDate.getUTCMinutes() !== minutes ||
    parsedDate.getUTCSeconds() !== calendarSecond
  ) {
    return undefined;
  }
  return seconds === 60 ? timestamp + 1_000 : timestamp;
}
