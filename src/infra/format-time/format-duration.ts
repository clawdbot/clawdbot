// Duration formatting helpers produce compact, precise, and human display
// strings from millisecond values.
export type FormatDurationSecondsOptions = {
  decimals?: number;
  unit?: "s" | "seconds";
};

export type FormatDurationCompactOptions = {
  /** Add space between units: "2m 5s" instead of "2m5s". Default: false */
  spaced?: boolean;
};

export function formatDurationSeconds(
  ms: number,
  options: FormatDurationSecondsOptions = {},
): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  const decimals = options.decimals ?? 1;
  const unit = options.unit ?? "s";
  const seconds = Math.max(0, ms) / 1000;
  const fixed = seconds.toFixed(Math.max(0, decimals));
  const trimmed = fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  return unit === "seconds" ? `${trimmed} seconds` : `${trimmed}s`;
}

/** Precise decimal-seconds output: "500ms" or "1.23s". Input is milliseconds. */
export function formatDurationPrecise(
  ms: number,
  options: FormatDurationSecondsOptions = {},
): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return formatDurationSeconds(ms, {
    decimals: options.decimals ?? 2,
    unit: options.unit ?? "s",
  });
}

/**
 * Compact compound duration: "500ms", "45s", "2m5s", "1h30m".
 * With `spaced`: "45s", "2m 5s", "1h 30m".
 * Omits trailing zero components: "1m" not "1m 0s", "2h" not "2h 0m".
 * Returns undefined for null/undefined/non-finite/non-positive input.
 */
export function formatDurationCompact(
  ms?: number | null,
  options?: FormatDurationCompactOptions,
): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const sep = options?.spaced ? " " : "";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d${sep}${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${sep}${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m${sep}${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Rounded single-unit duration for display: "500ms", "5s", "3m", "2h", "5d".
 * Returns fallback string for null/undefined/non-finite input.
 */
export function formatDurationHuman(ms?: number | null, fallback = "n/a"): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return fallback;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const sec = Math.round(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr}h`;
  }
  const day = Math.round(hr / 24);
  return `${day}d`;
}
