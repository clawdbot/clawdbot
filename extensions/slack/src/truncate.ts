// Slack plugin module implements truncate behavior.
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export function truncateSlackText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  // Slice on a code-point boundary so a surrogate pair (emoji / astral char)
  // straddling the limit is dropped whole, instead of leaving a lone surrogate
  // half that serializes to an invalid `\uD83D` in the Slack payload.
  if (max <= 1) {
    return sliceUtf16Safe(trimmed, 0, max);
  }
  return `${sliceUtf16Safe(trimmed, 0, max - 1)}…`;
}

export function countSlackTextUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate Slack text without splitting a code point or exceeding a UTF-8 byte limit. */
export function truncateSlackTextByUtf8Bytes(value: string, maxBytes: number): string {
  const trimmed = value.trim();
  if (maxBytes <= 0) {
    return "";
  }
  if (countSlackTextUtf8Bytes(trimmed) <= maxBytes) {
    return trimmed;
  }

  const suffix = "…";
  const suffixBytes = countSlackTextUtf8Bytes(suffix);
  const prefixBudget = maxBytes >= suffixBytes ? maxBytes - suffixBytes : maxBytes;
  let prefix = "";
  let prefixBytes = 0;
  for (const character of trimmed) {
    const characterBytes = countSlackTextUtf8Bytes(character);
    if (prefixBytes + characterBytes > prefixBudget) {
      break;
    }
    prefix += character;
    prefixBytes += characterBytes;
  }
  return maxBytes >= suffixBytes ? `${prefix}${suffix}` : prefix;
}
