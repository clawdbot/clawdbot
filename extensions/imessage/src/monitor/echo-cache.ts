export type SentMessageLookup = {
  text?: string;
  messageId?: string;
};

export type SentMessageCache = {
  remember: (scope: string, lookup: SentMessageLookup) => void;
  /**
   * Check whether an inbound message matches a recently-sent outbound message.
   *
   * @param skipIdShortCircuit - When true, skip the early return on message-ID
   *   mismatch and fall through to text-based matching. Use this for self-chat
   *   `is_from_me=true` messages where the inbound ID is a numeric SQLite row ID
   *   that will never match the GUID outbound IDs, but text matching is still
   *   the right way to identify agent reply echoes.
   */
  has: (scope: string, lookup: SentMessageLookup, skipIdShortCircuit?: boolean) => boolean;
};

// Echo arrival observed at ~2.2s on M4 Mac Mini (SQLite poll interval is the bottleneck).
// 4s provides ~80% margin. If echoes arrive after TTL expiry, the system degrades to
// duplicate delivery (noisy but not lossy) — never message loss.
const SENT_MESSAGE_TEXT_TTL_MS = 4_000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;
const LEADING_ATTRIBUTED_BODY_CORRUPTION_MARKERS = /^[\uFEFF\uFFFD\uFFFE\uFFFF]+/u;

function normalizeEchoTextKey(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(LEADING_ATTRIBUTED_BODY_CORRUPTION_MARKERS, "")
    .trim();
  return normalized ? normalized : null;
}

function normalizeEchoMessageIdKey(messageId: string | undefined): string | null {
  if (!messageId) {
    return null;
  }
  const normalized = messageId.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

class DefaultSentMessageCache implements SentMessageCache {
  private textCache = new Map<string, number>();
  private textBackedByIdCache = new Map<string, number>();
  private messageIdCache = new Map<string, number>();

  remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      this.textCache.set(`${scope}:${textKey}`, Date.now());
    }
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
      if (textKey) {
        this.textBackedByIdCache.set(`${scope}:${textKey}`, Date.now());
      }
    }
    this.cleanup();
  }

  has(scope: string, lookup: SentMessageLookup, skipIdShortCircuit = false): boolean {
    this.cleanup();
    const textKey = normalizeEchoTextKey(lookup.text);
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
      if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) {
        return true;
      }
      const textTimestamp = textKey ? this.textCache.get(`${scope}:${textKey}`) : undefined;
      const textBackedByIdTimestamp = textKey
        ? this.textBackedByIdCache.get(`${scope}:${textKey}`)
        : undefined;
      const hasTextOnlyMatch =
        typeof textTimestamp === "number" &&
        (!textBackedByIdTimestamp || textTimestamp > textBackedByIdTimestamp);
      if (!skipIdShortCircuit && !hasTextOnlyMatch) {
        return false;
      }
    }
    if (textKey) {
      const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
      if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.textCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
        this.textCache.delete(key);
      }
    }
    for (const [key, timestamp] of this.textBackedByIdCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
        this.textBackedByIdCache.delete(key);
      }
    }
    for (const [key, timestamp] of this.messageIdCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) {
        this.messageIdCache.delete(key);
      }
    }
  }
}

export function createSentMessageCache(): SentMessageCache {
  return new DefaultSentMessageCache();
}
