// Telegram helper module supports normalize behavior.
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

  const identity = resolveTelegramTargetIdentity(trimmed);
  if (!identity) {
    return undefined;
  }

  const keepLegacyGroupPrefix = /^group:/i.test(prefixStripped);
  const hasTopicSuffix = /:topic:\d+$/i.test(prefixStripped);
  const chatSegment = keepLegacyGroupPrefix ? `group:${identity.chatId}` : identity.chatId;
  if (identity.directMessagesTopicId != null) {
    return `${chatSegment}:direct-topic:${identity.directMessagesTopicId}`;
  }
  if (identity.messageThreadId == null) {
    return chatSegment;
  }
  const threadSuffix = hasTopicSuffix
    ? `:topic:${identity.messageThreadId}`
    : `:${identity.messageThreadId}`;
  return `${chatSegment}${threadSuffix}`;
}

function resolveTelegramTargetIdentity(raw: string) {
  const parsed = parseTelegramTarget(raw);
  const chatId = normalizeTelegramLookupTarget(parsed.chatId);
  if (!chatId) {
    return undefined;
  }
  return {
    chatId: normalizeLowercaseStringOrEmpty(chatId),
    messageThreadId: parsed.messageThreadId,
    directMessagesTopicId: parsed.directMessagesTopicId,
  };
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

export function telegramMessagingTargetsMatch(target: string, currentTarget: string): boolean {
  const targetIdentity = resolveTelegramTargetIdentity(target);
  const currentIdentity = resolveTelegramTargetIdentity(currentTarget);
  return (
    targetIdentity !== undefined &&
    currentIdentity !== undefined &&
    targetIdentity.chatId === currentIdentity.chatId &&
    targetIdentity.messageThreadId === currentIdentity.messageThreadId &&
    targetIdentity.directMessagesTopicId === currentIdentity.directMessagesTopicId
  );
}
