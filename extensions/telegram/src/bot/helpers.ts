import type { Chat, Message } from "grammy/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import {
  resolveCommandAuthorization,
  type CommandAuthorization,
} from "openclaw/plugin-sdk/command-auth-native";
import type {
  OpenClawConfig,
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramDmThreadReplies,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expandTelegramAllowFromWithAccessGroups } from "../access-groups.js";
import { firstDefined, normalizeAllowFrom, type NormalizedAllowFrom } from "../bot-access.js";
import { normalizeTelegramReplyToMessageId } from "../outbound-params.js";
import { resolveTelegramPreviewStreamMode } from "../preview-streaming.js";
import {
  buildSenderLabel,
  buildSenderName,
  expandTextLinks,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  isBinaryContent,
  normalizeForwardedContext,
  resolveTelegramTextContent,
  resolveTelegramMediaPlaceholder,
  type TelegramForwardedContext,
  type TelegramTextEntity,
} from "./body-helpers.js";
import type { TelegramGetChat, TelegramStreamMode } from "./types.js";

export type { TelegramForwardedContext, TelegramTextEntity } from "./body-helpers.js";
export {
  buildSenderLabel,
  buildSenderName,
  expandTextLinks,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  isBinaryContent,
  normalizeForwardedContext,
  resolveTelegramMediaPlaceholder,
};

const TELEGRAM_GENERAL_TOPIC_ID = 1;
const TELEGRAM_FORUM_FLAG_CACHE_MAX_CHATS = 1024;
const TELEGRAM_FORUM_FLAG_CACHE_TTL_MS = 10 * 60_000;
const telegramForumFlagByChatId = new Map<string, { expiresAtMs: number; isForum: boolean }>();

export function resetTelegramForumFlagCacheForTest(): void {
  telegramForumFlagByChatId.clear();
}

function cacheTelegramForumFlag(chatId: string | number, isForum: boolean, nowMs = Date.now()) {
  const cacheKey = String(chatId);
  if (
    !telegramForumFlagByChatId.has(cacheKey) &&
    telegramForumFlagByChatId.size >= TELEGRAM_FORUM_FLAG_CACHE_MAX_CHATS
  ) {
    const oldestKey = telegramForumFlagByChatId.keys().next().value;
    if (oldestKey !== undefined) {
      telegramForumFlagByChatId.delete(oldestKey);
    }
  }
  telegramForumFlagByChatId.set(cacheKey, {
    expiresAtMs: nowMs + TELEGRAM_FORUM_FLAG_CACHE_TTL_MS,
    isForum,
  });
}

function hadUnsafeTelegramText(raw: unknown, sanitized: string): boolean {
  return typeof raw === "string" && raw.trim().length > 0 && sanitized.trim().length === 0;
}

export type TelegramThreadSpec = {
  id?: number;
  scope: "dm" | "forum" | "none";
};

function normalizeTelegramDmThreadReplies(value: unknown): TelegramDmThreadReplies | undefined {
  return value === "off" || value === "inbound" || value === "always" ? value : undefined;
}

export function resolveTelegramDmThreadReplies(params: {
  accountConfig?: TelegramAccountConfig;
  directConfig?: TelegramDirectConfig;
}): TelegramDmThreadReplies {
  return (
    normalizeTelegramDmThreadReplies(params.directConfig?.threadReplies) ??
    normalizeTelegramDmThreadReplies(params.accountConfig?.dm?.threadReplies) ??
    "off"
  );
}

export function shouldUseTelegramDmThreadSession(params: {
  dmThreadId?: number;
  accountConfig?: TelegramAccountConfig;
  directConfig?: TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): boolean {
  if (params.dmThreadId == null) {
    return false;
  }
  if (params.directConfig?.requireTopic === true || params.topicConfig) {
    return true;
  }
  return resolveTelegramDmThreadReplies(params) !== "off";
}

export function extractTelegramForumFlag(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || !("is_forum" in value)) {
    return undefined;
  }
  const forum = value.is_forum;
  return typeof forum === "boolean" ? forum : undefined;
}

export async function resolveTelegramForumFlag(params: {
  chatId: string | number;
  chatType?: Chat["type"];
  isGroup: boolean;
  isForum?: boolean;
  getChat?: TelegramGetChat;
}): Promise<boolean> {
  if (typeof params.isForum === "boolean") {
    if (params.isGroup && params.chatType === "supergroup") {
      cacheTelegramForumFlag(params.chatId, params.isForum);
    }
    return params.isForum;
  }
  if (!params.isGroup || params.chatType !== "supergroup" || !params.getChat) {
    return false;
  }
  const cacheKey = String(params.chatId);
  const nowMs = Date.now();
  const cached = telegramForumFlagByChatId.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.isForum;
  }
  if (cached) {
    telegramForumFlagByChatId.delete(cacheKey);
  }
  try {
    const resolved = extractTelegramForumFlag(await params.getChat(params.chatId)) === true;
    cacheTelegramForumFlag(params.chatId, resolved, nowMs);
    return resolved;
  } catch {
    return false;
  }
}

// Preserve recovered forum metadata so downstream handlers do not need to re-query getChat.
export function withResolvedTelegramForumFlag<T extends { chat: object }>(
  message: T,
  isForum: boolean,
): T {
  const current = extractTelegramForumFlag(message.chat);
  if (current === isForum) {
    return message;
  }
  return {
    ...message,
    chat: {
      ...message.chat,
      is_forum: isForum,
    },
  };
}

export async function resolveTelegramGroupAllowFromContext(params: {
  cfg?: OpenClawConfig;
  chatId: string | number;
  accountId?: string;
  senderId?: string;
  isGroup?: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
  groupAllowFrom?: Array<string | number>;
  readChannelAllowFromStore?: typeof readChannelAllowFromStore;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => {
    groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
    topicConfig?: TelegramTopicConfig;
  };
}): Promise<{
  resolvedThreadId?: number;
  dmThreadId?: number;
  storeAllowFrom: string[];
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  groupAllowOverride?: Array<string | number>;
  effectiveGroupAllow: NormalizedAllowFrom;
  hasGroupAllowOverride: boolean;
}> {
  const accountId = normalizeAccountId(params.accountId);
  // Use resolveTelegramThreadSpec to handle both forum groups AND DM topics
  const threadSpec = resolveTelegramThreadSpec({
    isGroup: params.isGroup ?? false,
    isForum: params.isForum,
    messageThreadId: params.messageThreadId,
  });
  const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const storeAllowFrom = await (params.readChannelAllowFromStore ?? readChannelAllowFromStore)(
    "telegram",
    process.env,
    accountId,
  ).catch(() => []);
  const { groupConfig, topicConfig } = params.resolveTelegramGroupConfig(
    params.chatId,
    threadIdForConfig,
  );
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const expandedGroupAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom: groupAllowOverride ?? params.groupAllowFrom,
    accountId,
    senderId: params.senderId,
  });
  // Group sender access must remain explicit (groupAllowFrom/per-group allowFrom only).
  // DM pairing store entries are not a group authorization source.
  const effectiveGroupAllow = normalizeAllowFrom(expandedGroupAllowFrom);
  const hasGroupAllowOverride = groupAllowOverride !== undefined;
  return {
    resolvedThreadId,
    dmThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
    hasGroupAllowOverride,
  };
}

/**
 * Resolve the thread ID for Telegram forum topics.
 * For non-forum groups, returns undefined even if messageThreadId is present
 * (reply threads in regular groups should not create separate sessions).
 * For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
 */
export function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}) {
  // Non-forum groups: ignore message_thread_id (reply threads are not real topics)
  if (!params.isForum) {
    return undefined;
  }
  // Forum groups: use the topic ID, defaulting to General topic
  if (params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId;
}

export function resolveTelegramThreadSpec(params: {
  isGroup: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
}): TelegramThreadSpec {
  if (params.isGroup) {
    const id = resolveTelegramForumThreadId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    });
    return {
      id,
      scope: params.isForum ? "forum" : "none",
    };
  }
  if (params.messageThreadId == null) {
    return { scope: "dm" };
  }
  return {
    id: params.messageThreadId,
    scope: "dm",
  };
}

/**
 * Build thread params for Telegram API calls (messages, media).
 *
 * IMPORTANT: Thread IDs behave differently based on chat type:
 * - DMs (private chats): Include message_thread_id when present (DM topics)
 * - Forum topics: Skip thread_id=1 (General topic), include others
 * - Regular groups: Thread IDs are ignored by Telegram
 *
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
 *
 * @param thread - Thread specification with ID and scope
 * @returns API params object or undefined if thread_id should be omitted
 */
export function buildTelegramThreadParams(thread?: TelegramThreadSpec | null) {
  if (thread?.id == null) {
    return undefined;
  }
  const normalized = Math.trunc(thread.id);

  if (thread.scope === "dm") {
    return normalized > 0 ? { message_thread_id: normalized } : undefined;
  }

  // Telegram rejects message_thread_id=1 for General forum topic
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) {
    return undefined;
  }

  return { message_thread_id: normalized };
}

/**
 * Build a Telegram routing target that keeps real topic/thread ids in-band.
 *
 * This is used by generic reply plumbing that may not always carry a separate
 * `threadId` field through every hop. General forum topic stays chat-scoped
 * because Telegram rejects `message_thread_id=1` for message sends.
 */
export function buildTelegramRoutingTarget(
  chatId: number | string,
  thread?: TelegramThreadSpec | null,
): string {
  const base = `telegram:${chatId}`;
  const threadParams = buildTelegramThreadParams(thread);
  const messageThreadId = threadParams?.message_thread_id;
  if (typeof messageThreadId !== "number") {
    return base;
  }
  return `${base}:topic:${messageThreadId}`;
}

/**
 * Build thread params for typing indicators (sendChatAction).
 * Empirically, General topic (id=1) needs message_thread_id for typing to appear.
 */
export function buildTypingThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  return { message_thread_id: Math.trunc(messageThreadId) };
}

export function resolveTelegramStreamMode(telegramCfg?: {
  streaming?: unknown;
  streamMode?: unknown;
}): TelegramStreamMode {
  return resolveTelegramPreviewStreamMode(telegramCfg);
}

export function buildTelegramGroupPeerId(chatId: number | string, messageThreadId?: number) {
  return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}

/**
 * Resolve the direct-message peer identifier for Telegram routing/session keys.
 *
 * In some Telegram DM deliveries (for example certain business/chat bridge flows),
 * `chat.id` can differ from the actual sender user id. Prefer sender id when present
 * so per-peer DM scopes isolate users correctly.
 */
export function resolveTelegramDirectPeerId(params: {
  chatId: number | string;
  senderId?: number | string | null;
}) {
  const senderId =
    params.senderId != null ? (normalizeOptionalString(String(params.senderId)) ?? "") : "";
  if (senderId) {
    return senderId;
  }
  return String(params.chatId);
}

export function buildTelegramGroupFrom(chatId: number | string, messageThreadId?: number) {
  return `telegram:group:${buildTelegramGroupPeerId(chatId, messageThreadId)}`;
}

export function isTelegramCommandsAllowFromConfigured(cfg: OpenClawConfig): boolean {
  const commandsAllowFrom = cfg.commands?.allowFrom;
  return (
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]))
  );
}

export function resolveTelegramCommandAuthorization(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: number;
  isGroup: boolean;
  resolvedThreadId?: number;
  senderId?: string;
  senderUsername?: string;
}): CommandAuthorization {
  return resolveCommandAuthorization({
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      AccountId: params.accountId,
      ChatType: params.isGroup ? "group" : "direct",
      From: params.isGroup
        ? buildTelegramGroupFrom(params.chatId, params.resolvedThreadId)
        : `telegram:${params.chatId}`,
      SenderId: params.senderId || undefined,
      SenderUsername: params.senderUsername || undefined,
    },
    cfg: params.cfg,
    commandAuthorized: false,
  });
}

/**
 * Build parentPeer for forum topic binding inheritance.
 * When a message comes from a forum topic, the peer ID includes the topic suffix
 * (e.g., `-1001234567890:topic:99`). To allow bindings configured for the base
 * group ID to match, we provide the parent group as `parentPeer` so the routing
 * layer can fall back to it when the exact peer doesn't match.
 */
export function buildTelegramParentPeer(params: {
  isGroup: boolean;
  resolvedThreadId?: number;
  chatId: number | string;
}): { kind: "group"; id: string } | undefined {
  if (!params.isGroup || params.resolvedThreadId == null) {
    return undefined;
  }
  return { kind: "group", id: String(params.chatId) };
}

export function buildGroupLabel(msg: Message, chatId: number | string, messageThreadId?: number) {
  const title = msg.chat?.title;
  const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) {
    return `${title} id:${chatId}${topicSuffix}`;
  }
  return `group:${chatId}${topicSuffix}`;
}

export function resolveTelegramReplyId(raw?: string): number | undefined {
  return normalizeTelegramReplyToMessageId(raw);
}

export type TelegramReplyTarget = {
  id?: string;
  sender: string;
  senderId?: string;
  senderUsername?: string;
  body?: string;
  kind: "reply" | "quote";
  source: "reply_to_message" | "external_reply";
  quoteText?: string;
  quotePosition?: number;
  quoteEntities?: TelegramTextEntity[];
  /** Forward context if the reply target was itself a forwarded message (issue #9619). */
  forwardedFrom?: TelegramForwardedContext;
  quoteSourceText?: string;
  quoteSourceEntities?: TelegramTextEntity[];
};

export function describeReplyTarget(msg: Message): TelegramReplyTarget | null {
  const reply = msg.reply_to_message;
  const externalReply = (msg as Message & { external_reply?: Message }).external_reply;
  const quote =
    msg.quote ?? (externalReply as (Message & { quote?: Message["quote"] }) | undefined)?.quote;
  const rawQuoteText = quote?.text;
  const quoteText = resolveTelegramTextContent(rawQuoteText);
  let body = "";
  let kind: TelegramReplyTarget["kind"] = "reply";
  const filteredQuoteText = hadUnsafeTelegramText(rawQuoteText, quoteText);

  body = quoteText.trim();
  if (body) {
    kind = "quote";
  }

  const replyLike = reply ?? externalReply;
  const rawReplyText =
    replyLike && typeof replyLike.text === "string"
      ? replyLike.text
      : replyLike && typeof replyLike.caption === "string"
        ? replyLike.caption
        : undefined;
  const safeReplyText = resolveTelegramTextContent(rawReplyText);
  const replyTextParts = replyLike && safeReplyText ? getTelegramTextParts(replyLike) : undefined;
  let filteredReplyText = false;
  if (!body && replyLike) {
    const replyBody = safeReplyText.trim();
    filteredReplyText = hadUnsafeTelegramText(rawReplyText, replyBody);
    body = replyBody;
    if (!body) {
      body = resolveTelegramMediaPlaceholder(replyLike) ?? "";
      if (!body) {
        const locationData = extractTelegramLocation(replyLike);
        if (locationData) {
          body = formatLocationText(locationData);
        }
      }
    }
  }
  if (!body && !replyLike) {
    return null;
  }
  if (!body && !filteredQuoteText && !filteredReplyText) {
    return null;
  }
  const sender = replyLike ? buildSenderName(replyLike) : undefined;
  const senderLabel = sender ?? "unknown sender";
  const source = reply ? "reply_to_message" : "external_reply";
  const quotePosition =
    kind === "quote" && typeof quote?.position === "number" && Number.isFinite(quote.position)
      ? Math.trunc(quote.position)
      : undefined;
  const quoteEntities =
    kind === "quote" && Array.isArray(quote?.entities) ? quote.entities : undefined;

  // Extract forward context from the resolved reply target (reply_to_message or external_reply).
  const forwardedFrom = replyLike ? (normalizeForwardedContext(replyLike) ?? undefined) : undefined;

  return {
    id: replyLike?.message_id ? String(replyLike.message_id) : undefined,
    sender: senderLabel,
    senderId: replyLike?.from?.id != null ? String(replyLike.from.id) : undefined,
    senderUsername: replyLike?.from?.username ?? undefined,
    body: body || undefined,
    kind,
    source,
    quoteText: kind === "quote" ? quoteText : undefined,
    quotePosition,
    quoteEntities,
    forwardedFrom,
    quoteSourceText: replyTextParts?.text || undefined,
    quoteSourceEntities: replyTextParts?.entities,
  };
}
