/**
 * Removes short-window duplicate user turns from compaction summaries.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";

const DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS = 60_000;
const MIN_DUPLICATE_USER_MESSAGE_CHARS = 24;

type MessageLike = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  __openclaw?: unknown;
};

type DuplicateUserMessageOptions = {
  windowMs?: number;
};

type DuplicateUserMessageTimestampBucket = {
  earliest: number;
  latest: number;
};

function normalizeUserMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return undefined;
    }
    textParts.push(block.text);
  }
  return textParts.join("\n").replace(/\s+/g, " ").trim();
}

function duplicateSignature(message: unknown): { key: string; timestamp: number } | undefined {
  if (!isRecord(message) || message.role !== "user" || typeof message.timestamp !== "number") {
    return undefined;
  }
  const text = normalizeUserMessageContent(message.content);
  if (!text || text.length < MIN_DUPLICATE_USER_MESSAGE_CHARS || hasPersistedMedia(message)) {
    return undefined;
  }
  // Persisted sender identity keeps distinct participants separate while senderless legacy
  // turns retain the old retry behavior. A JSON tuple avoids sender/text delimiter collisions.
  const rawMetadata = message["__openclaw"];
  const metadata = isRecord(rawMetadata) ? rawMetadata : undefined;
  const senderId = normalizeOptionalString(metadata?.senderId);
  const senderUsername = normalizeOptionalString(metadata?.senderUsername);
  const senderName = normalizeOptionalString(metadata?.senderName);
  const senderSource = senderId ? "id" : senderUsername ? "username" : senderName ? "name" : "";
  const senderIdentity = senderId ?? senderUsername ?? senderName ?? "";
  return {
    key: JSON.stringify([senderSource, senderIdentity, text.normalize("NFC")]),
    timestamp: message.timestamp,
  };
}

/** Drop later duplicate user messages while preserving the first prompt. */
export function dedupeDuplicateUserMessagesForCompaction<T extends MessageLike>(
  messages: readonly T[],
  options: DuplicateUserMessageOptions = {},
): T[] {
  const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
  if (windowMs < 0 || Number.isNaN(windowMs)) {
    return [...messages];
  }
  const seenBucketsByKey = new Map<string, Map<number, DuplicateUserMessageTimestampBucket>>();
  let removed = 0;
  const result: T[] = [];
  for (const message of messages) {
    const signature = duplicateSignature(message);
    if (!signature || !Number.isFinite(signature.timestamp)) {
      result.push(message);
      continue;
    }
    let buckets = seenBucketsByKey.get(signature.key);
    if (!buckets) {
      buckets = new Map();
      seenBucketsByKey.set(signature.key, buckets);
    }
    const bucketId =
      windowMs === 0 ? signature.timestamp : Math.floor(signature.timestamp / windowMs);
    const currentBucket = buckets.get(bucketId);
    const previousBucket = windowMs > 0 ? buckets.get(bucketId - 1) : undefined;
    // Looking backward only preserves genuine backdated turns; bucket extrema
    // still detect every earlier retry without losing independently late streams.
    const previousElapsedMs = previousBucket
      ? signature.timestamp - previousBucket.latest
      : undefined;
    const duplicate =
      (currentBucket !== undefined && currentBucket.earliest <= signature.timestamp) ||
      (previousElapsedMs !== undefined && previousElapsedMs >= 0 && previousElapsedMs <= windowMs);
    if (currentBucket) {
      currentBucket.earliest = Math.min(currentBucket.earliest, signature.timestamp);
      currentBucket.latest = Math.max(currentBucket.latest, signature.timestamp);
    } else {
      buckets.set(bucketId, { earliest: signature.timestamp, latest: signature.timestamp });
    }
    if (duplicate) {
      // Keep the first prompt and drop only later repeats. The first copy anchors the summarized
      // branch while duplicate retries no longer inflate compaction context.
      removed += 1;
      continue;
    }
    result.push(message);
  }
  return removed > 0 ? result : [...messages];
}
