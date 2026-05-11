import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeTelegramLookupTarget, parseTelegramTarget } from "./targets.js";

const TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;

function normalizeTelegramTargetBody(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const prefixStripped = trimmed.replace(TELEGRAM_PREFIX_RE, "").trim();
  if (!prefixStripped) {
    return undefined;
  }

  const parsed = parseTelegramTarget(trimmed);
  const normalizedChatId = normalizeTelegramLookupTarget(parsed.chatId);
  if (!normalizedChatId) {
    return undefined;
  }

  const keepLegacyGroupPrefix = /^group:/i.test(prefixStripped);
  const hasTopicSuffix = /:topic:\d+$/i.test(prefixStripped);
  const chatSegment = keepLegacyGroupPrefix ? `group:${normalizedChatId}` : normalizedChatId;
  if (parsed.messageThreadId == null) {
    return chatSegment;
  }
  const threadSuffix = hasTopicSuffix
    ? `:topic:${parsed.messageThreadId}`
    : `:${parsed.messageThreadId}`;
  return `${chatSegment}${threadSuffix}`;
}

export function normalizeTelegramMessagingTarget(raw: string): string | undefined {
  const normalizedBody = normalizeTelegramTargetBody(raw);
  if (!normalizedBody) {
    return undefined;
  }
  return normalizeLowercaseStringOrEmpty(`telegram:${normalizedBody}`);
}

export function looksLikeTelegramTargetId(raw: string): boolean {
  return normalizeTelegramTargetBody(raw) !== undefined;
}
