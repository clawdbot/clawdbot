/**
 * Normalizes timestamps and formats user-facing dates/times for agent prompts.
 */
import { execFileSync } from "node:child_process";
import { resolveDateTimestampMs } from "@openclaw/normalization-core/number-coercion";

export type ResolvedTimeFormat = "12" | "24";

let cachedTimeFormat: ResolvedTimeFormat | undefined;

function buildNormalizedTimestamp(
  timestampMs: number,
): { timestampMs: number; timestampUtc: string } | undefined {
  if (!Number.isSafeInteger(timestampMs)) {
    return undefined;
  }
  const timestampUtc = new Date(timestampMs).toISOString();
  return { timestampMs, timestampUtc };
}

/** Resolve a valid IANA timezone from config, host preferences, or UTC. */
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

/** Resolve 12/24-hour display preference, detecting the host for `auto`. */
export function resolveUserTimeFormat(preference?: "auto" | "12" | "24"): ResolvedTimeFormat {
  if (preference === "12" || preference === "24") {
    return preference;
  }
  if (cachedTimeFormat) {
    return cachedTimeFormat;
  }
  cachedTimeFormat = detectSystemTimeFormat() ? "24" : "12";
  return cachedTimeFormat;
}

/** Format a stable YYYY-MM-DD stamp in the requested timezone. */
export function formatDateStamp(nowMs: number, timeZone: string): string {
  const timestampMs = resolveDateTimestampMs(nowMs);
  const date = new Date(timestampMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return date.toISOString().slice(0, 10);
}

/** Normalize Date, second, millisecond, or parseable string timestamps. */
function normalizeTimestamp(
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
  try {
    return buildNormalizedTimestamp(timestampMs);
  } catch {
    return undefined;
  }
}

/** Add normalized timestamp fields without overwriting valid existing values. */
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
      // macOS omits the key for locale-default behavior.
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
      // Windows detection is best-effort; Intl below is the portable fallback.
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

/** Format the prompt-facing localized time string with weekday and date. */
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
