import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import { resolveIMessageEchoMediaKey } from "../state-contract.js";
// Imessage plugin module implements echo cache behavior.
import { stripLeadingEchoTextCorruptionMarkers } from "./echo-text-corruption.js";
import { hasPersistedIMessageEcho } from "./persisted-echo-cache.js";

type SentMessageLookup = {
  text?: string;
  media?: MediaPlaceholderTextFact;
  messageId?: string;
};

type SentMessageLookupOptions = {
  skipIdShortCircuit?: boolean;
  includePendingText?: boolean;
  requireTextMatchForId?: boolean;
};

type SentMessageFactCacheEntry = {
  timestamp: number;
  backedByMessageId: boolean;
};

type SentMessageIdCacheEntry = {
  timestamp: number;
  textKey?: string;
  mediaKey?: string;
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
  has: (
    scope: string,
    lookup: SentMessageLookup,
    options?: boolean | SentMessageLookupOptions,
  ) => boolean;
};

// Echo arrival observed at ~2.2s on M4 Mac Mini (SQLite poll interval is the bottleneck).
// 4s provides ~80% margin. If echoes arrive after TTL expiry, the system degrades to
// duplicate delivery (noisy but not lossy) — never message loss.
const SENT_MESSAGE_TEXT_TTL_MS = 4_000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;

function normalizeEchoTextKey(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = stripLeadingEchoTextCorruptionMarkers(
    text.replace(/\r\n?/g, "\n").trim(),
  ).trim();
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
  private textCache = new Map<string, SentMessageFactCacheEntry>();
  private mediaCache = new Map<string, SentMessageFactCacheEntry>();
  private messageIdCache = new Map<string, SentMessageIdCacheEntry>();

  remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeEchoTextKey(lookup.text);
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    const timestamp = Date.now();
    if (textKey) {
      this.textCache.set(`${scope}:${textKey}`, {
        timestamp,
        backedByMessageId: messageIdKey != null,
      });
    }
    if (mediaKey) {
      this.mediaCache.set(`${scope}:${mediaKey}`, {
        timestamp,
        backedByMessageId: messageIdKey != null,
      });
    }
    if (messageIdKey) {
      this.messageIdCache.set(`${scope}:${messageIdKey}`, {
        timestamp,
        ...(textKey ? { textKey } : {}),
        ...(mediaKey ? { mediaKey } : {}),
      });
    }
    this.cleanup();
  }

  has(
    scope: string,
    lookup: SentMessageLookup,
    options: boolean | SentMessageLookupOptions = false,
  ): boolean {
    this.cleanup();
    const resolvedOptions =
      typeof options === "boolean" ? { skipIdShortCircuit: options } : options;
    if (
      hasPersistedIMessageEcho({
        scope,
        text: lookup.text,
        media: lookup.media,
        messageId: lookup.messageId,
        skipIdShortCircuit: resolvedOptions.skipIdShortCircuit,
        includePendingText: resolvedOptions.includePendingText,
        requireTextMatchForId: resolvedOptions.requireTextMatchForId,
        messageIdMaxAgeMs: resolvedOptions.requireTextMatchForId
          ? SENT_MESSAGE_TEXT_TTL_MS
          : undefined,
      })
    ) {
      return true;
    }
    const textKey = normalizeEchoTextKey(lookup.text);
    const mediaKey = resolveIMessageEchoMediaKey(lookup.media);
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    const now = Date.now();
    const textEntry = textKey ? this.textCache.get(`${scope}:${textKey}`) : undefined;
    const mediaEntry = mediaKey ? this.mediaCache.get(`${scope}:${mediaKey}`) : undefined;
    let canUseMediaFallback = !messageIdKey;
    if (messageIdKey) {
      const idEntry = this.messageIdCache.get(`${scope}:${messageIdKey}`);
      const messageIdTtlMs = resolvedOptions.requireTextMatchForId
        ? SENT_MESSAGE_TEXT_TTL_MS
        : SENT_MESSAGE_ID_TTL_MS;
      if (idEntry && now - idEntry.timestamp <= messageIdTtlMs) {
        if (
          !resolvedOptions.requireTextMatchForId ||
          (textKey != null && idEntry.textKey === textKey)
        ) {
          return true;
        }
      }
      // Reply-parent identities are only echoes when the same cached send also
      // owns the inbound text; never fall through to a different text entry.
      if (resolvedOptions.requireTextMatchForId) {
        return false;
      }
      const hasTextOnlyMatch = textEntry?.backedByMessageId === false;
      const hasMediaOnlyMatch = mediaEntry?.backedByMessageId === false;
      canUseMediaFallback = hasMediaOnlyMatch;
      if (!resolvedOptions.skipIdShortCircuit && !hasTextOnlyMatch && !hasMediaOnlyMatch) {
        return false;
      }
    }
    if (textEntry && now - textEntry.timestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
      return true;
    }
    if (
      mediaEntry &&
      canUseMediaFallback &&
      now - mediaEntry.timestamp <= SENT_MESSAGE_TEXT_TTL_MS
    ) {
      return true;
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.textCache.entries()) {
      if (now - entry.timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
        this.textCache.delete(key);
      }
    }
    for (const [key, entry] of this.mediaCache.entries()) {
      if (now - entry.timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
        this.mediaCache.delete(key);
      }
    }
    for (const [key, entry] of this.messageIdCache.entries()) {
      if (now - entry.timestamp > SENT_MESSAGE_ID_TTL_MS) {
        this.messageIdCache.delete(key);
      }
    }
  }
}

export function createSentMessageCache(): SentMessageCache {
  return new DefaultSentMessageCache();
}
