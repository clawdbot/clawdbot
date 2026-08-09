// Signal plugin module implements mentions behavior.
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SignalMention } from "./event-handler.types.js";

const OBJECT_REPLACEMENT = "\uFFFC";

type SignalNativeMentionFacts = {
  canDetectBotMention: boolean;
  hasAnyMention: boolean;
  mentionsBot: boolean;
};

type SignalNativeMentionIdentity = {
  account?: string | null;
  accountUuid?: string | null;
};

function isValidMention(mention: SignalMention | null | undefined): mention is SignalMention {
  if (!mention) {
    return false;
  }
  if (!(mention.uuid || mention.number)) {
    return false;
  }
  if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
    return false;
  }
  if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
    return false;
  }
  return mention.length > 0;
}

function clampBounds(start: number, length: number, textLength: number) {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeLength = Math.max(0, Math.trunc(length));
  const safeEnd = Math.min(textLength, safeStart + safeLength);
  return { start: safeStart, end: safeEnd };
}

function isValidStructuredMention(
  message: string,
  mention: SignalMention | null | undefined,
): mention is SignalMention {
  if (!mention || !(mention.uuid || mention.number)) {
    return false;
  }
  const { start, length } = mention;
  if (typeof start !== "number" || typeof length !== "number") {
    return false;
  }
  return (
    Number.isInteger(start) &&
    Number.isInteger(length) &&
    start >= 0 &&
    length > 0 &&
    start + length <= message.length
  );
}

function normalizeAccountPhone(account?: string | null) {
  const trimmed = account?.trim();
  return trimmed ? normalizeE164(trimmed) : undefined;
}

function resolveSignalNativeMentionFacts(params: {
  message: string;
  mentions?: SignalMention[] | null;
  account?: string | null;
  accountUuid?: string | null;
}): SignalNativeMentionFacts {
  const validMentions = (params.mentions ?? []).filter((mention) =>
    isValidStructuredMention(params.message, mention),
  );
  const botUuid = params.accountUuid?.trim();
  const botPhone = normalizeAccountPhone(params.account);
  const canDetectBotMention = Boolean(botUuid || botPhone);
  const mentionsBot = validMentions.some((mention) => {
    const mentionUuid = mention.uuid?.trim();
    if (botUuid && mentionUuid === botUuid) {
      return true;
    }
    const mentionNumber = mention.number?.trim();
    return Boolean(botPhone && mentionNumber && normalizeE164(mentionNumber) === botPhone);
  });

  return {
    canDetectBotMention,
    hasAnyMention: validMentions.length > 0,
    mentionsBot,
  };
}

export function resolveSignalMentionFacts(
  identity: SignalNativeMentionIdentity,
  message: string,
  mentions?: SignalMention[] | null,
) {
  return resolveSignalNativeMentionFacts({
    message,
    mentions,
    account: identity.account,
    accountUuid: identity.accountUuid,
  });
}

export function renderSignalMentions(message: string, mentions?: SignalMention[] | null) {
  if (!message || !mentions?.length) {
    return message;
  }

  let normalized = message;
  const candidates = mentions.filter(isValidMention).toSorted((a, b) => b.start! - a.start!);

  for (const mention of candidates) {
    const identifier = mention.uuid ?? mention.number;
    if (!identifier) {
      continue;
    }

    const { start, end } = clampBounds(mention.start!, mention.length!, normalized.length);
    if (start >= end) {
      continue;
    }
    const slice = normalized.slice(start, end);

    if (!slice.includes(OBJECT_REPLACEMENT)) {
      continue;
    }

    normalized = normalized.slice(0, start) + `@${identifier}` + normalized.slice(end);
  }

  return normalized;
}
