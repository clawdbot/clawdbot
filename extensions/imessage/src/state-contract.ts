// Pure state contracts shared by doctor migrations and the live iMessage caches.
// Keep runtime/store imports out: detecting legacy state must not initialize the channel.
import { createHash } from "node:crypto";
import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";

export const IMESSAGE_REPLY_CACHE_NAMESPACE = "imessage.reply-cache";
export const IMESSAGE_REPLY_CACHE_MAX_ENTRIES = 2000;
export const IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE = "imessage.reply-cache-counter";
export const IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES = 1;
export const IMESSAGE_REPLY_CACHE_COUNTER_KEY = "short-id-counter";
export const IMESSAGE_REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function resolveIMessageReplyCacheEntryKey(messageId: string): string {
  return createHash("sha256").update(messageId, "utf8").digest("hex").slice(0, 32);
}

// Defense-in-depth bound on the retry map. The cursor is one plugin-state
// value, so keep the retry payload well below the 1 MiB facade limit.
const MAX_FAILURE_RETRY_MAP_SIZE = 512;
const MAX_FAILURE_RETRY_MAP_JSON_BYTES = 48_000;
const textEncoder = new TextEncoder();
export const IMESSAGE_CATCHUP_CURSOR_NAMESPACE = "imessage.catchup-cursors";
export const IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES = 256;

export type IMessageCatchupCursor = {
  /** Timestamp (ms since epoch) of the highest-watermark message we processed. */
  lastSeenMs: number;
  /** ROWID of the highest-watermark processed message. Monotonic in chat.db. */
  lastSeenRowid: number;
  /** UTC ms timestamp of the most recent cursor write. */
  updatedAt: number;
  /**
   * Per-GUID failure counter, preserved across runs. Two states:
   * - `1 <= count < maxFailureRetries`: the GUID is still retrying and
   *   continues to hold the cursor back.
   * - `count >= maxFailureRetries`: catchup has given up on the GUID. The
   *   message is skipped on sight (no dispatch attempt) and the cursor no
   *   longer waits on it. Entry stays in the map until the cursor naturally
   *   advances past the message's timestamp.
   *
   * A successful dispatch removes the entry. Optional on the persisted shape
   * so older cursor values without this field load cleanly.
   */
  failureRetries?: Record<string, number>;
};

export function resolveIMessageCatchupCursorKey(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 32);
}

/**
 * Bound the retry map so a pathological storm of unique failing GUIDs
 * cannot grow the cursor value without limit. Keeps the `maxSize` entries
 * with the highest counts (closest to give-up) when over the bound.
 */
export function capFailureRetriesMap(
  map: Record<string, number>,
  maxSize: number = MAX_FAILURE_RETRY_MAP_SIZE,
  maxBytes: number = MAX_FAILURE_RETRY_MAP_JSON_BYTES,
): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= maxSize && textEncoder.encode(JSON.stringify(map)).byteLength <= maxBytes) {
    return map;
  }
  // Sort by count desc; stable tiebreak on guid string so the retained set
  // is deterministic across runs (important for cursor-value diffing during
  // debugging).
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const capped: Record<string, number> = {};
  for (const [guid, count] of entries.slice(0, maxSize)) {
    capped[guid] = count;
    if (textEncoder.encode(JSON.stringify(capped)).byteLength > maxBytes) {
      delete capped[guid];
      break;
    }
  }
  return capped;
}

export type PersistedEchoEntry = {
  scope: string;
  text?: string;
  media?: MediaPlaceholderTextFact;
  messageId?: string;
  timestamp: number;
  expiresAt?: number;
  pending?: true;
};

// 12h comfortably outlives the inbound replay guard window
// (IMESSAGE_INBOUND_DEDUPE_TTL_MS) so an own-outbound row that imsg re-emits
// after a bridge reconnect is still recognized as the agent's own echo rather
// than re-ingested as an external send. A shorter window would let own rows
// fall out of the dedupe set before a reconnect burst replays the messages
// around them.
export const IMESSAGE_SENT_ECHOES_TTL_MS = 12 * 60 * 60 * 1000;
export const IMESSAGE_SENT_ECHOES_NAMESPACE = "imessage.sent-echoes";
export const IMESSAGE_SENT_ECHOES_MAX_ENTRIES = 256;

export function resolveIMessageSentEchoEntryKey(entry: PersistedEchoEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        entry.scope,
        entry.text ?? "",
        resolveIMessageEchoMediaKey(entry.media) ?? "",
        entry.messageId ?? "",
        entry.timestamp,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export function resolveIMessageEchoMediaKey(
  media: MediaPlaceholderTextFact | null | undefined,
): string | undefined {
  const contentType = media?.contentType?.trim().toLowerCase() || undefined;
  const kind = media?.kind && media.kind !== "unknown" ? media.kind : undefined;
  if (kind) {
    return `kind:${kind}`;
  }
  const normalizedContentType = contentType?.split(";", 1)[0]?.trim();
  return normalizedContentType ? `mime:${normalizedContentType}` : undefined;
}
