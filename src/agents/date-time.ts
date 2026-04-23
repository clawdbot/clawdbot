import { execFileSync } from "node:child_process";

export type TimeFormatPreference = "auto" | "12" | "24";
export type ResolvedTimeFormat = "12" | "24";

let cachedTimeFormat: ResolvedTimeFormat | undefined;

export function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

export function resolveUserTimeFormat(preference?: TimeFormatPreference): ResolvedTimeFormat {
  if (preference === "12" || preference === "24") {
    return preference;
  }
  if (cachedTimeFormat) {
    return cachedTimeFormat;
  }
  cachedTimeFormat = detectSystemTimeFormat() ? "24" : "12";
  return cachedTimeFormat;
}

export function normalizeTimestamp(
  raw: unknown,
): { timestampMs: number; timestampUtc: string } | undefined {
  if (raw == null) {
    return undefined;
  }
  let timestampMs: number | undefined;

  if (raw instanceof Date) {
    timestampMs = raw.getTime();
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    timestampMs = raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) {
        if (trimmed.includes(".")) {
          timestampMs = Math.round(num * 1000);
        } else if (trimmed.length >= 13) {
          timestampMs = Math.round(num);
        } else {
          timestampMs = Math.round(num * 1000);
        }
      }
    } else {
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) {
        timestampMs = parsed;
      }
    }
  }

  if (timestampMs === undefined || !Number.isFinite(timestampMs)) {
    return undefined;
  }
  return { timestampMs, timestampUtc: new Date(timestampMs).toISOString() };
}

export function withNormalizedTimestamp<T extends Record<string, unknown>>(
  value: T,
  rawTimestamp: unknown,
): T & { timestampMs?: number; timestampUtc?: string } {
  const normalized = normalizeTimestamp(rawTimestamp);
  if (!normalized) {
    return value;
  }
  return {
    ...value,
    timestampMs:
      typeof value.timestampMs === "number" && Number.isFinite(value.timestampMs)
        ? value.timestampMs
        : normalized.timestampMs,
    timestampUtc:
      typeof value.timestampUtc === "string" && value.timestampUtc.trim()
        ? value.timestampUtc
        : normalized.timestampUtc,
  };
}

function detectSystemTimeFormat(): boolean {
  if (process.platform === "darwin") {
    try {
      const result = execFileSync("defaults", ["read", "-g", "AppleICUForce24HourTime"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (result === "1") {
        return true;
      }
      if (result === "0") {
        return false;
      }
    } catch {
      // Not set, fall through
    }
  }

  if (process.platform === "win32") {
    try {
      const result = execFileSync(
        "powershell",
        ["-Command", "(Get-Culture).DateTimeFormat.ShortTimePattern"],
        { encoding: "utf8", timeout: 1000 },
      ).trim();
      if (result.startsWith("H")) {
        return true;
      }
      if (result.startsWith("h")) {
        return false;
      }
    } catch {
      // Fall through
    }
  }

  try {
    const sample = new Date(2000, 0, 1, 13, 0);
    const formatted = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(sample);
    return formatted.includes("13");
  } catch {
    return false;
  }
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) {
    return "th";
  }
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

export function formatUserTime(
  date: Date,
  timeZone: string,
  format: ResolvedTimeFormat,
): string | undefined {
  const use24Hour = format === "24";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: use24Hour ? "2-digit" : "numeric",
      minute: "2-digit",
      hourCycle: use24Hour ? "h23" : "h12",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    if (!map.weekday || !map.year || !map.month || !map.day || !map.hour || !map.minute) {
      return undefined;
    }
    const dayNum = Number.parseInt(map.day, 10);
    const suffix = ordinalSuffix(dayNum);
    const timePart = use24Hour
      ? `${map.hour}:${map.minute}`
      : `${map.hour}:${map.minute} ${map.dayPeriod ?? ""}`.trim();
    return `${map.weekday}, ${map.month} ${dayNum}${suffix}, ${map.year} - ${timePart}`;
  } catch {
    return undefined;
  }
}
