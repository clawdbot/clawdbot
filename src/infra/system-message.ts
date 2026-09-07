// System messages use a stable prefix so generated system events can be
// identified without extra metadata in plain chat transcripts.
export const SYSTEM_MARK = "⚙️";

function normalizeSystemText(value: string): string {
  return value.trim();
}

/** Return true when text already carries the system-message prefix. */
export function hasSystemMark(text: string): boolean {
  return normalizeSystemText(text).startsWith(SYSTEM_MARK);
}

/** Prefix non-empty text as a system message without double-prefixing. */
export function prefixSystemMessage(text: string): string {
  const normalized = normalizeSystemText(text);
  if (!normalized) {
    return normalized;
  }
  if (hasSystemMark(normalized)) {
    return normalized;
  }
  return `${SYSTEM_MARK} ${normalized}`;
}
