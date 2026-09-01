import type { RelativeTimeUnit } from "@openclaw/normalization-core";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { workboardLocale } from "../host.ts";
import { t } from "../i18n/index.ts";
function formatUnit(value: number, unit: RelativeTimeUnit | "millisecond"): string {
  return new Intl.NumberFormat(workboardLocale(), {
    style: "unit",
    unit,
    unitDisplay: "narrow",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatDurationCompact(ms?: number | null): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  const roundedMs = Math.round(ms);
  if (roundedMs < 1000) {
    return formatUnit(roundedMs, "millisecond");
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return formatUnit(totalSeconds, "second");
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    const parts = [formatUnit(totalMinutes, "minute")];
    if (seconds > 0) {
      parts.push(formatUnit(seconds, "second"));
    }
    return parts.join(" ");
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const parts = [formatUnit(days, "day")];
    if (remainingHours > 0) {
      parts.push(formatUnit(remainingHours, "hour"));
    }
    return parts.join(" ");
  }
  const minutes = totalMinutes % 60;
  const parts = [formatUnit(hours, "hour")];
  if (minutes > 0) {
    parts.push(formatUnit(minutes, "minute"));
  }
  return parts.join(" ");
}

export function formatDateMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleDateString(workboardLocale(), options);
}

export function formatDateTimeMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleString(workboardLocale(), options);
}

export function clampText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, max - 1))}…`;
}
