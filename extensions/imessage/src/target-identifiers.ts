// Imessage helper module normalizes database-backed target identifiers.
const BARE_CHAT_IDENTIFIER_RE = /^[0-9a-f]{32}$/i;

export function isIMessagePhoneLikeHandle(raw: string): boolean {
  return /^(?:tel:)?[+\d\s().-]+$/i.test(raw.trim());
}

export function normalizeBareIMessageChatIdentifier(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!BARE_CHAT_IDENTIFIER_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}
