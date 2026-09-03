import { bucketRelativeTimeMs, type RelativeTimeUnit } from "@openclaw/normalization-core";
// Control UI module implements format behavior.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  resolveCompactDurationParts,
  resolveSingleUnitDurationParts,
  type DurationUnit,
} from "../../../src/infra/format-time/format-duration-internal.ts";
import { i18n, t } from "../i18n/index.ts";
import { formatUiError } from "./format-error.ts";

export { formatByteSize } from "@openclaw/normalization-core";

export function formatCountdown(deadlineMs: number, nowMs: number, padMinutes = false): string {
  const totalSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
  const minutes = String(Math.floor(totalSeconds / 60));
  return `${padMinutes ? minutes.padStart(2, "0") : minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

type FormatTimeAgoOptions = {
  suffix?: boolean;
  fallback?: string;
};

type FormatRelativeTimestampOptions = {
  dateFallback?: boolean;
  timezone?: string;
  fallback?: string;
  suffix?: boolean;
};

function formatUnit(value: number | bigint, unit: DurationUnit): string {
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "unit",
    unit,
    unitDisplay: "narrow",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatRelative(value: number, unit: RelativeTimeUnit): string {
  return new Intl.RelativeTimeFormat(i18n.getLocale(), {
    numeric: "auto",
    style: "narrow",
  }).format(value, unit);
}

export function formatTimeAgo(
  durationMs: number | null | undefined,
  options: FormatTimeAgoOptions = {},
): string {
  const fallback = options.fallback ?? t("common.unknown");
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return fallback;
  }

  const { value, unit } = bucketRelativeTimeMs(durationMs);
  if (unit === "second") {
    if (options.suffix !== false) {
      return t("common.justNow");
    }
  }
  return options.suffix === false ? formatUnit(value, unit) : formatRelative(-value, unit);
}

export function formatRelativeTimestamp(
  timestampMs: number | null | undefined,
  options: FormatRelativeTimestampOptions = {},
): string {
  const fallback = options.fallback ?? t("common.na");
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return fallback;
  }

  const diff = timestampMs - Date.now();
  const isPast = diff <= 0;
  const { value, unit } = bucketRelativeTimeMs(Math.abs(diff));
  if (unit === "second") {
    if (options.suffix === false) {
      return formatUnit(value, unit);
    }
    return isPast ? t("common.justNow") : formatRelative(value, unit);
  }

  if (options.dateFallback && unit === "day" && value > 7) {
    try {
      return new Intl.DateTimeFormat(i18n.getLocale(), {
        month: "short",
        day: "numeric",
        ...(options.timezone ? { timeZone: options.timezone } : {}),
      }).format(new Date(timestampMs));
    } catch {
      // Invalid time zones should still leave a useful localized relative value.
    }
  }

  const signedValue = isPast ? -value : value;
  return options.suffix === false ? formatUnit(value, unit) : formatRelative(signedValue, unit);
}

export function formatDurationCompact(ms?: number | null): string | undefined {
  return resolveCompactDurationParts(ms)
    ?.map(({ value, unit }) => formatUnit(value, unit))
    .join(" ");
}

export function formatDurationHuman(ms?: number | null, fallback = t("common.na")): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return fallback;
  }
  return resolveSingleUnitDurationParts(ms)
    .map(({ value, unit }) => formatUnit(value, unit))
    .join(" ");
}

export function formatUnknownText(
  value: unknown,
  opts: { fallback?: string; pretty?: boolean } = {},
): string {
  const fallback = opts.fallback ?? "";
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  try {
    const serialized = JSON.stringify(value, null, opts.pretty ? 2 : undefined);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall back when value is not JSON-serializable.
  }
  if (value instanceof Error) {
    return formatUiError(value);
  }
  return Object.prototype.toString.call(value);
}

export function formatMs(ms?: number | null): string {
  const timestampMs = asDateTimestampMs(ms);
  if (timestampMs === undefined) {
    return t("common.na");
  }
  return new Date(timestampMs).toLocaleString(i18n.getLocale(), {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDateMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleDateString(i18n.getLocale(), options);
}

export function formatTimeMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleTimeString(i18n.getLocale(), options ?? { timeStyle: "short" });
}

export function formatDateTimeMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleString(i18n.getLocale(), options);
}

export function formatList(values?: Array<string | null | undefined>): string {
  if (!values || values.length === 0) {
    return t("common.none");
  }
  return values.filter((v): v is string => Boolean(v && v.trim())).join(", ");
}

export function clampText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, max - 1))}…`;
}

export function truncateText(
  value: string,
  max: number,
): {
  text: string;
  truncated: boolean;
  total: number;
} {
  if (value.length <= max) {
    return { text: value, truncated: false, total: value.length };
  }
  return {
    text: truncateUtf16Safe(value, Math.max(0, max)),
    truncated: true,
    total: value.length,
  };
}

export function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function formatCost(cost: number | null | undefined, fallback = "$0.00"): string {
  if (cost == null || !Number.isFinite(cost)) {
    return fallback;
  }
  if (cost === 0) {
    return "$0.00";
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

// The one token formatter: every surface showing the same count must render the
// same string, or a session reads "16k" in one pane and "15.6k" in another.
export function formatCompactTokenCount(
  tokens: number | null | undefined,
  options: { thousandsSuffix?: string; millionsSuffix?: string; trimTrailingZero?: boolean } = {},
): string {
  if (tokens == null || !Number.isFinite(tokens)) {
    return "0";
  }
  const thousandsSuffix = options.thousandsSuffix ?? "k";
  const millionsSuffix = options.millionsSuffix ?? "M";
  const trimTrailingZero = options.trimTrailingZero ?? true;
  const trim = (value: string) => (trimTrailingZero ? value.replace(/\.0$/, "") : value);
  // Month-scale provider totals can cross a billion; keep the suffix ladder closed.
  if (tokens >= 1_000_000_000) {
    return `${trim((tokens / 1_000_000_000).toFixed(1))}B`;
  }
  if (tokens >= 1_000_000) {
    return `${trim((tokens / 1_000_000).toFixed(1))}${millionsSuffix}`;
  }
  if (tokens >= 1_000) {
    const thousands = (tokens / 1_000).toFixed(1);
    if (Number(thousands) >= 1_000) {
      return `${trim((tokens / 1_000_000).toFixed(1))}${millionsSuffix}`;
    }
    return `${trim(thousands)}${thousandsSuffix}`;
  }
  return String(Math.round(tokens));
}

export function formatContextTokenCapacity(tokens: number): string {
  if (tokens < 1_000_000) {
    return formatCompactTokenCount(tokens);
  }
  return `${Math.floor(tokens / 100_000) / 10}M`;
}
