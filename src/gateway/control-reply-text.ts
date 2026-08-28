// Gateway control-reply text classifier.
// Suppresses internal auto-reply tokens before they leak to chat surfaces.
import { isSilentReplyText, SILENT_REPLY_TOKEN, stripSilentToken } from "../auto-reply/tokens.js";

const SUPPRESSED_CONTROL_REPLY_TOKENS = [
  SILENT_REPLY_TOKEN,
  "ANNOUNCE_SKIP",
  "REPLY_SKIP",
] as const;

const MIN_BARE_PREFIX_LENGTH_BY_TOKEN: Readonly<
  Record<(typeof SUPPRESSED_CONTROL_REPLY_TOKENS)[number], number>
> = {
  // Hold a lone `N` (first NO_REPLY delta) as a pending lead fragment so it
  // cannot flash on delta-rendering channels. SILENT_REPLY_TOKEN skips the
  // case guard below so a mixed-case "No" lead is also held pending (it may
  // still grow into NO_REPLY); the final payload renders "No" if the turn
  // resolves to natural language. Length-1 floor is safe for this token only.
  [SILENT_REPLY_TOKEN]: 1,
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

/** Remove internal control tokens when a model appends one to visible reply text. */
export function stripSuppressedControlReplyToken(text: string): string {
  if (isSuppressedControlReplyText(text)) {
    return "";
  }
  let stripped = text;
  for (const token of SUPPRESSED_CONTROL_REPLY_TOKENS) {
    const next = stripSilentToken(stripped, token);
    if (next !== stripped.trim()) {
      stripped = next;
    }
  }
  return stripped;
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
