// Telegram plugin module implements outbound params behavior.
import {
  parseStrictInteger,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/number-runtime";

function parseIntegerId(value: unknown): number | undefined {
  return parseStrictInteger(value);
}

export function parseTelegramMessageThreadId(value: unknown): number | undefined {
  return parseStrictNonNegativeInteger(value);
}

export function normalizeTelegramReplyToMessageId(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return parseIntegerId(value);
  }
  const trimmed = value.trim();
  return trimmed ? parseIntegerId(trimmed) : undefined;
}

export function parseTelegramReplyToMessageId(replyToId?: unknown): number | undefined {
  return normalizeTelegramReplyToMessageId(replyToId);
}

export function parseTelegramThreadId(threadId?: string | number | null): number | undefined {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    return parseIntegerId(threadId);
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return undefined;
  }
  const topicMatch = /^-?\d+:topic:(\d+)$/.exec(trimmed);
  if (topicMatch) {
    return parseIntegerId(topicMatch[1]);
  }
  // DM topic session keys may scope thread ids as "<chatId>:<threadId>".
  const scopedMatch = /^-?\d+:(-?\d+)$/.exec(trimmed);
  const rawThreadId = scopedMatch ? scopedMatch[1] : trimmed;
  return parseIntegerId(rawThreadId);
}
