// Gateway control-reply text classifier.
// Suppresses internal auto-reply tokens before they leak to chat surfaces.
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

const SUPPRESSED_CONTROL_REPLY_TOKENS = [
  SILENT_REPLY_TOKEN,
  "ANNOUNCE_SKIP",
  "REPLY_SKIP",
] as const;

const MIN_BARE_PREFIX_LENGTH_BY_TOKEN: Readonly<
  Record<(typeof SUPPRESSED_CONTROL_REPLY_TOKENS)[number], number>
> = {
  [SILENT_REPLY_TOKEN]: 2,
  ANNOUNCE_SKIP: 3,
  REPLY_SKIP: 3,
};

function normalizeSuppressedControlReplyFragment(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const normalized = trimmed.toUpperCase();
  if (/[^A-Z_]/.test(normalized)) {
    return "";
  }
  return normalized;
}

/**
 * Return true when a chat-visible reply is exactly an internal control token.
 */
export function isSuppressedControlReplyText(text: string): boolean {
  const normalized = text.trim();
  return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => isSilentReplyText(normalized, token));
}

/**
 * Return true when streamed assistant text looks like the leading fragment of a control token.
 */
export function isSuppressedControlReplyLeadFragment(text: string): boolean {
  const trimmed = text.trim();
  const normalized = normalizeSuppressedControlReplyFragment(text);
  if (!normalized) {
    return false;
  }
  return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => {
    const tokenUpper = token.toUpperCase();
    if (normalized === tokenUpper) {
      return false;
    }
    if (!tokenUpper.startsWith(normalized)) {
      return false;
    }
    if (normalized.includes("_")) {
      return true;
    }
    if (token !== SILENT_REPLY_TOKEN && trimmed !== trimmed.toUpperCase()) {
      return false;
    }
    // Bare fragments are common while streaming. Require a minimum prefix so
    // ordinary words do not disappear just because they start like a token.
    return normalized.length >= MIN_BARE_PREFIX_LENGTH_BY_TOKEN[token];
  });
}
