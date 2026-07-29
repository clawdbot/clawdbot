// Control UI module implements format behavior.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  formatDurationCompact as formatDurationCompactCore,
  formatDurationHuman as formatDurationHumanCore,
} from "../../../src/infra/format-time/format-duration.ts";
import { i18n, t } from "../i18n/index.ts";

export { formatByteSize } from "@openclaw/normalization-core";

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

type FormatDurationCompactOptions = {
  spaced?: boolean;
};

type RelativeUnit = "second" | "minute" | "hour" | "day";

function formatUnit(value: number, unit: RelativeUnit | "millisecond"): string {
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "unit",
    unit,
    unitDisplay: "narrow",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatRelative(value: number, unit: RelativeUnit): string {
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

  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.round(seconds / 60);
  let value: number;
  let unit: RelativeUnit;
  if (seconds < 60) {
    if (options.suffix !== false) {
      return t("common.justNow");
    }
    value = seconds;
    unit = "second";
  } else if (minutes < 60) {
    value = minutes;
    unit = "minute";
  } else {
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
      value = hours;
      unit = "hour";
    } else {
      value = Math.round(hours / 24);
      unit = "day";
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
  const seconds = Math.round(Math.abs(diff) / 1000);
  if (seconds < 60) {
    if (options.suffix === false) {
      return formatUnit(seconds, "second");
    }
    return isPast ? t("common.justNow") : formatRelative(seconds, "second");
  }

  const minutes = Math.round(seconds / 60);
  let value = minutes;
  let unit: RelativeUnit = "minute";
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    value = hours;
    unit = "hour";
    if (hours >= 48) {
      value = Math.round(hours / 24);
      unit = "day";
    }
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

export function formatDurationCompact(
  ms?: number | null,
  options: FormatDurationCompactOptions = {},
): string | undefined {
  const coreValue = formatDurationCompactCore(ms, options);
  if (!coreValue || ms == null || !Number.isFinite(ms) || ms <= 0) {
    return coreValue;
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
    return parts.join(options.spaced ? " " : "");
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const parts = [formatUnit(days, "day")];
    if (remainingHours > 0) {
      parts.push(formatUnit(remainingHours, "hour"));
    }
    return parts.join(options.spaced ? " " : "");
  }
  const minutes = totalMinutes % 60;
  const parts = [formatUnit(hours, "hour")];
  if (minutes > 0) {
    parts.push(formatUnit(minutes, "minute"));
  }
  return parts.join(options.spaced ? " " : "");
}

export function formatDurationHuman(ms?: number | null, fallback = t("common.na")): string {
  const coreValue = formatDurationHumanCore(ms, fallback);
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return coreValue;
  }
  if (ms < 1000) {
    return formatUnit(Math.round(ms), "millisecond");
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return formatUnit(seconds, "second");
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return formatUnit(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? formatUnit(hours, "hour") : formatUnit(Math.round(hours / 24), "day");
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
    return value.message || value.name;
  }
  return Object.prototype.toString.call(value);
}

type UiTimeFormatPreference = "auto" | "12" | "24";

// Resolved `agents.defaults.timeFormat`, threaded in once at bootstrap. "auto"
// (or unset) keeps the browser locale default so existing deployments render
// unchanged; only "12"/"24" force an hour cycle across Control UI timestamps.
let uiTimeFormatPreference: UiTimeFormatPreference = "auto";

export function setUiTimeFormatPreference(value: UiTimeFormatPreference | null | undefined): void {
  uiTimeFormatPreference = value === "12" || value === "24" ? value : "auto";
}

export function resolveUiHourCycleOptions(): Intl.DateTimeFormatOptions {
  if (uiTimeFormatPreference === "12") {
    return { hour12: true };
  }
  if (uiTimeFormatPreference === "24") {
    return { hour12: false };
  }
  return {};
}

export function formatMs(ms?: number | null): string {
  const timestampMs = asDateTimestampMs(ms);
  if (timestampMs === undefined) {
    return t("common.na");
  }
  return new Date(timestampMs).toLocaleString(i18n.getLocale(), resolveUiHourCycleOptions());
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
    : new Date(timestampMs).toLocaleTimeString(i18n.getLocale(), {
        ...resolveUiHourCycleOptions(),
        ...options,
      });
}

export function formatDateTimeMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleString(i18n.getLocale(), {
        ...resolveUiHourCycleOptions(),
        ...options,
      });
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

export function formatTokens(tokens: number | null | undefined, fallback = "0"): string {
  if (tokens == null || !Number.isFinite(tokens)) {
    return fallback;
  }
  if (tokens < 1000) {
    return String(Math.round(tokens));
  }
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    if (k < 10) {
      return `${k.toFixed(1)}k`;
    }
    const rounded = Math.round(k);
    // 999_500..999_999 rounds to 1000k; roll it over to the M branch instead of emitting "1000k".
    if (rounded < 1000) {
      return `${rounded}k`;
    }
  }
  const m = tokens / 1_000_000;
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

export function formatCompactTokenCount(
  tokens: number,
  options: { thousandsSuffix?: string; millionsSuffix?: string; trimTrailingZero?: boolean } = {},
): string {
  const thousandsSuffix = options.thousandsSuffix ?? "k";
  const millionsSuffix = options.millionsSuffix ?? "M";
  const trimTrailingZero = options.trimTrailingZero ?? true;
  const trim = (value: string) => (trimTrailingZero ? value.replace(/\.0$/, "") : value);
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
  return String(tokens);
}

export function parseSessionKeyParts(
  key: string,
): { agentId: string; channel: string; accountId: string } | null {
  if (!key.startsWith("agent:")) {
    return null;
  }
  const rest = key.slice("agent:".length);
  const firstColon = rest.indexOf(":");
  if (firstColon < 1) {
    return null;
  }
  const agentId = rest.slice(0, firstColon);
  const afterAgent = rest.slice(firstColon + 1);
  const secondColon = afterAgent.indexOf(":");
  if (secondColon < 1) {
    return null;
  }
  const channel = afterAgent.slice(0, secondColon);
  const accountId = afterAgent.slice(secondColon + 1);
  if (!accountId) {
    return null;
  }
  return { agentId, channel, accountId };
}
