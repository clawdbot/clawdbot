import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";

function parseIntegerId(value: string): number | undefined {
  return parseStrictInteger(value);
}

export function normalizeTelegramReplyToMessageId(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? parseIntegerId(trimmed) : undefined;
}

export function parseTelegramReplyToMessageId(replyToId?: string | null): number | undefined {
  return normalizeTelegramReplyToMessageId(replyToId);
}

export function parseTelegramThreadId(threadId?: string | number | null): number | undefined {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
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
