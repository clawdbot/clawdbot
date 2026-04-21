/**
 * QQBot sender normalization and allowlist matching.
 *
 * Keeps QQ-specific quirks (the `qqbot:` prefix, uppercase-insensitive
 * comparison) localized to this module so the policy engine itself can
 * stay channel-agnostic.
 */

/** Normalize a single entry (openid): strip `qqbot:` prefix, uppercase, trim. */
export function normalizeQQBotSenderId(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return "";
  }
  return String(raw)
    .trim()
    .replace(/^qqbot:/i, "")
    .toUpperCase();
}

/** Normalize an entire allowFrom list, dropping empty entries. */
export function normalizeQQBotAllowFrom(list: Array<string | number> | undefined | null): string[] {
  if (!list || list.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const entry of list) {
    const normalized = normalizeQQBotSenderId(entry);
    if (normalized) {
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Build a matcher closure suitable for passing to the policy engine's
 * `isSenderAllowed` callback. The caller supplies the sender once, and
 * the returned function can be invoked against different allowlists
 * (DM allowlist vs group allowlist) without repeating normalization.
 */
export function createQQBotSenderMatcher(senderId: string): (allowFrom: string[]) => boolean {
  const normalizedSender = normalizeQQBotSenderId(senderId);
  return (allowFrom: string[]) => {
    if (allowFrom.length === 0) {
      return false;
    }
    if (allowFrom.includes("*")) {
      return true;
    }
    if (!normalizedSender) {
      return false;
    }
    return allowFrom.some((entry) => normalizeQQBotSenderId(entry) === normalizedSender);
  };
}
