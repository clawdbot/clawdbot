import { formatCompactTokenCount } from "@openclaw/normalization-core";

/** Formats a token count for compact human-facing status text. */
export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  return formatCompactTokenCount(safe, { thousandsPrecision: safe >= 10_000 ? 0 : 1 });
}
