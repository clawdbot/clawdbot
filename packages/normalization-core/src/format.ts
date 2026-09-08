import { expectDefined } from "./expect.js";

type ByteSizeUnit = "byte" | "kilo" | "mega" | "giga" | "tera";
type ByteSizeStyle = "iec" | "legacy-binary";

type ByteSizeFormatOptions = {
  style: ByteSizeStyle;
  maxUnit: ByteSizeUnit;
  separator: "" | " ";
  fractionDigits: number | ((value: number, unit: ByteSizeUnit) => number | null);
  floorUnits?: readonly ByteSizeUnit[];
};

const BYTE_SIZE_UNITS: readonly ByteSizeUnit[] = ["byte", "kilo", "mega", "giga", "tera"];
const BYTE_SIZE_STYLES = {
  iec: { base: 1024, labels: ["B", "KiB", "MiB", "GiB", "TiB"] },
  "legacy-binary": { base: 1024, labels: ["B", "KB", "MB", "GB", "TB"] },
} as const satisfies Record<ByteSizeStyle, { base: number; labels: readonly string[] }>;

export type RelativeTimeUnit = "second" | "minute" | "hour" | "day";

/** Buckets an absolute duration while preserving nested display rounding at unit boundaries. */
export function bucketRelativeTimeMs(durationMs: number): {
  value: number;
  unit: RelativeTimeUnit;
} {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return { value: seconds, unit: "second" };
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return { value: minutes, unit: "minute" };
  }
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? { value: hours, unit: "hour" }
    : { value: Math.round(hours / 24), unit: "day" };
}

/** Formats a byte count with caller-explicit scale, labels, precision, and unit cap. */
export function formatByteSize(bytes: number, options: ByteSizeFormatOptions): string {
  const { base, labels } = BYTE_SIZE_STYLES[options.style];
  const maxUnitIndex = BYTE_SIZE_UNITS.indexOf(options.maxUnit);
  let unitIndex = 0;
  let value = bytes;
  while (value >= base && unitIndex < maxUnitIndex) {
    value /= base;
    unitIndex += 1;
  }

  const unit = expectDefined(BYTE_SIZE_UNITS[unitIndex], "byte-size unit");
  const label = expectDefined(labels[unitIndex], "byte-size label");
  const fractionDigits =
    typeof options.fractionDigits === "function"
      ? options.fractionDigits(value, unit)
      : options.fractionDigits;
  if (fractionDigits === null) {
    return `${value}${options.separator}${label}`;
  }
  if (options.floorUnits?.includes(unit)) {
    value = Math.floor(value * 10 ** fractionDigits) / 10 ** fractionDigits;
  }
  return `${value.toFixed(fractionDigits)}${options.separator}${label}`;
}

/** Formats token units while callers retain input validation and whole-token rounding. */
export function formatCompactTokenCount(
  tokens: number,
  options: {
    thousandsPrecision?: 0 | 1;
    thousandsSuffix?: string;
    millionsSuffix?: string;
    trimTrailingZero?: boolean;
    maxUnit?: "million" | "billion";
  } = {},
): string {
  if (tokens < 1_000) {
    return String(Math.round(tokens));
  }
  const trim = (value: string) => (options.trimTrailingZero ? value.replace(/\.0$/, "") : value);
  // Billion presentation is based on the count, not rounded millions.
  if (options.maxUnit === "billion" && tokens >= 1_000_000_000) {
    return `${trim((tokens / 1_000_000_000).toFixed(1))}B`;
  }
  if (tokens < 1_000_000) {
    const thousands = (tokens / 1_000).toFixed(options.thousandsPrecision ?? 1);
    if (Number(thousands) < 1_000) {
      return `${trim(thousands)}${options.thousandsSuffix ?? "k"}`;
    }
  }
  return `${trim((tokens / 1_000_000).toFixed(1))}${options.millionsSuffix ?? "m"}`;
}
