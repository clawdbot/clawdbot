/**
 * Centralized relative-time formatting utilities.
 *
 * Consolidates 7+ scattered implementations (formatAge, formatAgeShort, formatAgo,
 * formatRelativeTime, formatElapsedTime) into two functions:
 *
 * - `formatTimeAgo(durationMs)` — format a duration as "5m ago" / "5m" (for known elapsed time)
 * - `formatRelativeTimestamp(epochMs)` — format an epoch timestamp relative to now (handles future)
 */
import { bucketRelativeTimeMs } from "@openclaw/normalization-core";

type FormatTimeAgoOptions = {
  /** Append "ago" suffix. Default: true. When false, returns bare unit: "5m", "2h" */
  suffix?: boolean;
  /** Return value for invalid/null/negative input. Default: "unknown" */
  fallback?: string;
};

/**
 * Format a duration (in ms) as a human-readable relative time.
 *
 * Input: how many milliseconds ago something happened.
 *
 * With suffix (default):  "just now", "5m ago", "3h ago", "2d ago"
 * Without suffix:         "0s", "5m", "3h", "2d"
 */
type TimeAgoBucket =
  | { kind: "invalid" }
  | { kind: "seconds"; count: number }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "days"; count: number };

/** Classify one elapsed duration so product-owned renderers share exact thresholds and rounding. */
export function classifyTimeAgo(durationMs: number | null | undefined): TimeAgoBucket {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return { kind: "invalid" };
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 1) {
    return { kind: "seconds", count: totalSeconds };
  }
  if (minutes < 60) {
    return { kind: "minutes", count: minutes };
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return { kind: "hours", count: hours };
  }
  return { kind: "days", count: Math.round(hours / 24) };
}

export function formatTimeAgo(
  durationMs: number | null | undefined,
  options?: FormatTimeAgoOptions,
): string {
  const suffix = options?.suffix !== false;
  const fallback = options?.fallback ?? "unknown";
  const bucket = classifyTimeAgo(durationMs);
  switch (bucket.kind) {
    case "invalid":
      return fallback;
    case "seconds":
      return suffix ? "just now" : `${bucket.count}s`;
    case "minutes":
      return suffix ? `${bucket.count}m ago` : `${bucket.count}m`;
    case "hours":
      return suffix ? `${bucket.count}h ago` : `${bucket.count}h`;
    case "days":
      return suffix ? `${bucket.count}d ago` : `${bucket.count}d`;
    default:
      throw new Error("unreachable relative-time bucket");
  }
}

type FormatRelativeTimestampOptions = {
  /** If true, fall back to short date (e.g. "Oct 5") for timestamps >7 days. Default: false */
  dateFallback?: boolean;
  /** IANA timezone for date fallback display */
  timezone?: string;
  /** Return value for invalid/null input. Default: "n/a" */
  fallback?: string;
};

/**
 * Format an epoch timestamp relative to now.
 *
 * Handles both past ("5m ago") and future ("in 5m") timestamps.
 * Optionally falls back to a short date for timestamps older than 7 days.
 */
export function formatRelativeTimestamp(
  timestampMs: number | null | undefined,
  options?: FormatRelativeTimestampOptions,
): string {
  const fallback = options?.fallback ?? "n/a";
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return fallback;
  }

  const diff = Date.now() - timestampMs;
  const absDiff = Math.abs(diff);
  const isPast = diff >= 0;

  const { value, unit } = bucketRelativeTimeMs(absDiff);
  if (unit === "second") {
    return isPast ? "just now" : "in <1m";
  }
  if (unit === "minute") {
    return isPast ? `${value}m ago` : `in ${value}m`;
  }
  if (unit === "hour") {
    return isPast ? `${value}h ago` : `in ${value}h`;
  }
  if (!options?.dateFallback || value <= 7) {
    return isPast ? `${value}d ago` : `in ${value}d`;
  }

  // Fall back to short date display for old timestamps
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(options.timezone ? { timeZone: options.timezone } : {}),
    }).format(new Date(timestampMs));
  } catch {
    return `${value}d ago`;
  }
}
