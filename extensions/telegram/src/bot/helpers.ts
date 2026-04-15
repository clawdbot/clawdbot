import type { Chat, Message } from "@grammyjs/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
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

function hadUnsafeTelegramText(raw: unknown, sanitized: string): boolean {
  return typeof raw === "string" && raw.trim().length > 0 && sanitized.trim().length === 0;
}

export type TelegramThreadSpec = {
  id?: number;
  scope: "dm" | "forum" | "none";
};

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
    return params.isForum;
  }
  if (!params.isGroup || params.chatType !== "supergroup" || !params.getChat) {
    return false;
  }
  try {
    return extractTelegramForumFlag(await params.getChat(params.chatId)) === true;
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
  chatId: string | number;
  accountId?: string;
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
  // Group sender access must remain explicit (groupAllowFrom/per-group allowFrom only).
  // DM pairing store entries are not a group authorization source.
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? params.groupAllowFrom);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
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
  /** Forward context if the reply target was itself a forwarded message (issue #9619). */
  forwardedFrom?: TelegramForwardedContext;
};

export function describeReplyTarget(msg: Message): TelegramReplyTarget | null {
  const reply = msg.reply_to_message;
  const externalReply = (msg as Message & { external_reply?: Message }).external_reply;
  const rawQuoteText =
    msg.quote?.text ??
    (externalReply as (Message & { quote?: { text?: string } }) | undefined)?.quote?.text;
  const quoteText = resolveTelegramTextContent(rawQuoteText);
  let body = "";
  let kind: TelegramReplyTarget["kind"] = "reply";
  const filteredQuoteText = hadUnsafeTelegramText(rawQuoteText, quoteText);

  body = quoteText.trim();
  if (body) {
    kind = "quote";
  }

  const replyLike = reply ?? externalReply;
  let filteredReplyText = false;
  if (!body && replyLike) {
    const rawReplyText =
      typeof replyLike.text === "string"
        ? replyLike.text
        : typeof replyLike.caption === "string"
          ? replyLike.caption
          : undefined;
    const replyBody = resolveTelegramTextContent(rawReplyText).trim();
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

  // Extract forward context from the resolved reply target (reply_to_message or external_reply).
  const forwardedFrom = replyLike ? (normalizeForwardedContext(replyLike) ?? undefined) : undefined;

  return {
    id: replyLike?.message_id ? String(replyLike.message_id) : undefined,
    sender: senderLabel,
    senderId: replyLike?.from?.id != null ? String(replyLike.from.id) : undefined,
    senderUsername: replyLike?.from?.username ?? undefined,
    body: body || undefined,
    kind,
    forwardedFrom,
  };
}
