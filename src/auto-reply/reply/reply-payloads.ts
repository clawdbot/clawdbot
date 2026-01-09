import { isMessagingToolDuplicate } from "../../agents/pi-embedded-helpers.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { extractReplyToTag } from "./reply-tags.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

export function applyReplyTagsToPayload(
  payload: ReplyPayload,
  currentMessageId?: string,
): ReplyPayload {
  if (typeof payload.text !== "string") return payload;
  const { cleaned, replyToId, hasTag } = extractReplyToTag(
    payload.text,
    currentMessageId,
  );
  return {
    ...payload,
    text: cleaned ? cleaned : undefined,
    replyToId: replyToId ?? payload.replyToId,
    replyToTag: hasTag || payload.replyToTag,
  };
}

export function isRenderablePayload(payload: ReplyPayload): boolean {
  return Boolean(
    payload.text ||
      payload.mediaUrl ||
      (payload.mediaUrls && payload.mediaUrls.length > 0),
  );
}

export function applyReplyThreading(params: {
  payloads: ReplyPayload[];
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
}): ReplyPayload[] {
  const { payloads, replyToMode, replyToChannel, currentMessageId } = params;
  const applyReplyToMode = createReplyToModeFilterForChannel(
    replyToMode,
    replyToChannel,
  );
  return payloads
    .map((payload) => applyReplyTagsToPayload(payload, currentMessageId))
    .filter(isRenderablePayload)
    .map(applyReplyToMode);
}

export function filterMessagingToolDuplicates(params: {
  payloads: ReplyPayload[];
  sentTexts: string[];
}): ReplyPayload[] {
  const { payloads, sentTexts } = params;
  if (sentTexts.length === 0) return payloads;
  return payloads.filter(
    (payload) => !isMessagingToolDuplicate(payload.text ?? "", sentTexts),
  );
}

function normalizeSlackTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return `user:${mentionMatch[1]}`.toLowerCase();
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("slack:")) {
    const id = trimmed.slice(6).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("#")) {
    const id = trimmed.slice(1).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  return `channel:${trimmed}`.toLowerCase();
}

function normalizeDiscordTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return `user:${mentionMatch[1]}`.toLowerCase();
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("discord:")) {
    const id = trimmed.slice(8).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  return `channel:${trimmed}`.toLowerCase();
}

function normalizeTelegramTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let normalized = trimmed;
  if (normalized.startsWith("telegram:")) {
    normalized = normalized.slice("telegram:".length).trim();
  } else if (normalized.startsWith("tg:")) {
    normalized = normalized.slice("tg:".length).trim();
  } else if (normalized.startsWith("group:")) {
    normalized = normalized.slice("group:".length).trim();
  }
  if (!normalized) return undefined;
  const tmeMatch =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (tmeMatch?.[1]) normalized = `@${tmeMatch[1]}`;
  if (!normalized) return undefined;
  return `telegram:${normalized}`.toLowerCase();
}

function normalizeTargetForProvider(
  provider: string,
  raw?: string,
): string | undefined {
  if (!raw) return undefined;
  switch (provider) {
    case "slack":
      return normalizeSlackTarget(raw);
    case "discord":
      return normalizeDiscordTarget(raw);
    case "telegram":
      return normalizeTelegramTarget(raw);
    default:
      return raw.trim().toLowerCase() || undefined;
  }
}

function normalizeAccountId(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function shouldSuppressMessagingToolReplies(params: {
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  accountId?: string;
}): boolean {
  const provider = params.messageProvider?.trim().toLowerCase();
  if (!provider) return false;
  const originTarget = normalizeTargetForProvider(
    provider,
    params.originatingTo,
  );
  if (!originTarget) return false;
  const originAccount = normalizeAccountId(params.accountId);
  const sentTargets = params.messagingToolSentTargets ?? [];
  if (sentTargets.length === 0) return false;
  return sentTargets.some((target) => {
    if (!target?.provider) return false;
    if (target.provider.trim().toLowerCase() !== provider) return false;
    const targetKey = normalizeTargetForProvider(provider, target.to);
    if (!targetKey) return false;
    const targetAccount = normalizeAccountId(target.accountId);
    if (originAccount && targetAccount && originAccount !== targetAccount) {
      return false;
    }
    return targetKey === originTarget;
  });
}
