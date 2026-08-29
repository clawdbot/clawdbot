import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const WEB_PUSH_DISPLAY_LABEL_MAX_CHARS = 80;

/** Bound untrusted identifiers before they become lock-screen-visible text. */
export function webPushDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return truncateUtf16Safe(normalized, WEB_PUSH_DISPLAY_LABEL_MAX_CHARS).trimEnd() || undefined;
}
