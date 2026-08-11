/**
 * Removes short-window duplicate user turns from compaction summaries.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

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

function normalizeUserMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      return undefined;
    }
    if (block.type === "image") {
      return undefined;
    }
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n").replace(/\s+/g, " ").trim();
}

function duplicateSignature(message: unknown): { key: string; timestamp: number } | undefined {
  if (!isRecord(message) || message.role !== "user" || typeof message.timestamp !== "number") {
    return undefined;
  }
  const text = normalizeUserMessageContent(message.content);
  if (!text || text.length < MIN_DUPLICATE_USER_MESSAGE_CHARS) {
    return undefined;
  }
  // Persisted sender identity keeps distinct participants separate while senderless legacy
  // turns retain the old retry behavior. A JSON tuple avoids sender/text delimiter collisions.
  const metadata = message["__openclaw"];
  const senderId =
    isRecord(metadata) && typeof metadata.senderId === "string" ? metadata.senderId : "";
  return {
    key: JSON.stringify([senderId, text.normalize("NFC").toLowerCase()]),
    timestamp: message.timestamp,
  };
}

/** Drop later duplicate user messages while preserving the first prompt. */
export function dedupeDuplicateUserMessagesForCompaction<T extends MessageLike>(
  messages: readonly T[],
  options: DuplicateUserMessageOptions = {},
): T[] {
  const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
  const lastSeenAtByKey = new Map<string, number>();
  let removed = 0;
  const result: T[] = [];
  for (const message of messages) {
    const signature = duplicateSignature(message);
    if (!signature) {
      result.push(message);
      continue;
    }
    const lastSeenAt = lastSeenAtByKey.get(signature.key);
    lastSeenAtByKey.set(signature.key, signature.timestamp);
    if (typeof lastSeenAt === "number" && signature.timestamp - lastSeenAt <= windowMs) {
      // Keep the first prompt and drop only later repeats. The first copy anchors the summarized
      // branch while duplicate retries no longer inflate compaction context.
      removed += 1;
      continue;
    }
    result.push(message);
  }
  return removed > 0 ? result : [...messages];
}
