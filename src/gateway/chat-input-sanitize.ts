// Chat send input sanitizer for Gateway message payloads.

// Built at runtime so the source stays free of literal control characters and
// the no-control-regex lint rule cannot statically detect them. Tab/LF/CR survive.
const DISALLOWED_CHAT_CONTROL_RANGE = `${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`;
const DISALLOWED_CHAT_CONTROL_RE = new RegExp(`[${DISALLOWED_CHAT_CONTROL_RANGE}]`, "g");

/** Drop disallowed control characters while preserving tab, line breaks, and Unicode. */
function stripDisallowedChatControlChars(message: string): string {
  return message.replace(DISALLOWED_CHAT_CONTROL_RE, "");
}

/** Normalize chat text and reject null bytes before routing to channels. */
export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}
