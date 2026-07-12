// Control UI module implements format behavior.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  formatDurationCompact,
  formatDurationHuman,
} from "../../../src/infra/format-time/format-duration.ts";
import {
  formatRelativeTimestamp,
  formatTimeAgo,
} from "../../../src/infra/format-time/format-relative.ts";
import { t } from "../i18n/index.ts";

export { formatRelativeTimestamp, formatTimeAgo, formatDurationCompact, formatDurationHuman };

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
  return new Date(timestampMs).toLocaleString([], resolveUiHourCycleOptions());
}

export function formatDateMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleDateString([], options);
}

export function formatTimeMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleTimeString([], { ...resolveUiHourCycleOptions(), ...options });
}

export function formatDateTimeMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleString([], { ...resolveUiHourCycleOptions(), ...options });
}

export function formatList(values?: Array<string | null | undefined>): string {
  if (!values || values.length === 0) {
    return "none";
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
