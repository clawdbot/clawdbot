// Telegram plugin module implements message cache behavior.
import type { Message } from "grammy/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessageBody,
  type TelegramMediaKind,
} from "./bot/body-helpers.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  normalizeForwardedContext,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import { resolveTelegramIgnoreDisposition } from "./ignore-command.js";
import {
  isTelegramMessageCacheSourceMessage,
  parsePersistedTelegramIgnoredMediaGroup,
  parsePersistedTelegramIgnoredMessage,
  parseTelegramResolvedMedia,
  type PersistedTelegramMessageCacheEntry,
  type PersistedTelegramMessagePrivacyEntry,
  type TelegramResolvedMedia,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
  TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
  TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_MAX_ENTRIES,
  TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_NAMESPACE,
  type TelegramMessageThreadBinding,
} from "./message-cache-persistence.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import {
  parseTelegramPromptContextProjection,
  type TelegramPromptContextProjection,
  type TelegramPromptContextProjectionMarker,
} from "./prompt-context-projection.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

export type TelegramReplyChainEntry = NonNullable<MsgContext["ReplyChain"]>[number] & {
  mediaKind?: TelegramMediaKind;
};

export type TelegramCachedMessageNode = Omit<TelegramReplyChainEntry, "messageId"> & {
  messageId: string;
  resolvedMedia?: TelegramResolvedMedia;
  sourceMessage: Message;
  promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
  threadBinding?: TelegramMessageThreadBinding;
};

type TelegramConversationContextNode = {
  node: TelegramCachedMessageNode;
  isReplyTarget?: boolean;
};

type TelegramMessageCache = {
  record: (params: {
    accountId: string;
    chatId: string | number;
    msg: Message;
    botUserId?: number;
    botUsername?: string;
    promptContextProjection?: TelegramPromptContextProjection;
    /** Set only while recording an authenticated provider event or response. */
    providerObservedThread?: TelegramThreadSpec;
    threadId?: number;
  }) => Promise<TelegramCachedMessageNode>;
  recordResolvedMedia: (params: {
    accountId: string;
    botUserId?: number;
    chatId: string | number;
    messageId: string;
    media: TelegramResolvedMedia & { path?: string; fileName?: string };
  }) => Promise<void>;
  remove: (params: {
    accountId: string;
    chatId: string | number;
    messageId: string;
    mediaGroupId?: string;
  }) => Promise<boolean>;
  isIgnored: (params: {
    accountId: string;
    chatId: string | number;
    messageId: string;
    mediaGroupId?: string;
  }) => Promise<boolean>;
  get: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
  }) => Promise<TelegramCachedMessageNode | null>;
  recentBefore: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    limit: number;
  }) => Promise<TelegramCachedMessageNode[]>;
  around: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    before: number;
    after: number;
  }) => Promise<TelegramCachedMessageNode[]>;
  latestMatchingAtOrBefore: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    matches: (node: TelegramCachedMessageNode) => boolean;
  }) => Promise<TelegramCachedMessageNode | null>;
};

type MessageWithExternalReply = Message & { external_reply?: Message };
type MessageWithPromptContextTimestamp = Message & {
  openclaw_prompt_context_timestamp_ms?: unknown;
};

type TelegramMessageCacheBucket = {
  messages: Map<string, TelegramCachedMessageNode>;
  ignoredMessages: Set<string>;
  ignoredMediaGroups: Set<string>;
  privacyIdentities: Map<
    string,
    { kind: "ignored-message" | "ignored-media-group"; identity: string }
  >;
  hydrated: boolean;
  hydratePromise?: Promise<void>;
  persistentStore?: TelegramMessageCachePersistentStore;
  privacyStore?: TelegramMessagePrivacyPersistentStore;
};

type TelegramMessageObservationMode = "authoritative" | "partial";

type TelegramCachedMessageObservation = {
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
};

type TelegramEmbeddedReplyMessage = NonNullable<Message["reply_to_message"]>;

const DEFAULT_MAX_MESSAGES = 5000;
const PERSISTENT_BUCKET_KEY = `plugin-state:${TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE}`;
const TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY = Symbol.for("openclaw.telegram.messageCacheBuckets");

function getPersistedMessageCacheBuckets(): Map<string, TelegramMessageCacheBucket> {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY] as
    | Map<string, TelegramMessageCacheBucket>
    | undefined;
  if (existing) {
    return existing;
  }
  const created = new Map<string, TelegramMessageCacheBucket>();
  globalRecord[TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY] = created;
  return created;
}

type TelegramMessageCachePersistentStore = {
  register(key: string, value: PersistedTelegramMessageCacheEntry): Promise<void>;
  lookup(key: string): Promise<PersistedTelegramMessageCacheEntry | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: unknown }>>;
};

type TelegramMessagePrivacyPersistentStore = {
  register(key: string, value: PersistedTelegramMessagePrivacyEntry): Promise<void>;
  lookup(key: string): Promise<PersistedTelegramMessagePrivacyEntry | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: unknown }>>;
};

function telegramMessageCacheKey(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
  messageId: string;
}) {
  const key = `${params.accountId}:${params.chatId}:${params.messageId}`;
  return params.scopeKey ? `${params.scopeKey}:${key}` : key;
}

function telegramMessageCacheKeyPrefix(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
}) {
  const prefix = `${params.accountId}:${params.chatId}:`;
  return params.scopeKey ? `${params.scopeKey}:${prefix}` : prefix;
}

function telegramIgnoredMediaGroupIdentity(params: {
  accountId: string;
  chatId: string | number;
  mediaGroupId: string;
}): string {
  return JSON.stringify([params.accountId, String(params.chatId), params.mediaGroupId]);
}

function telegramIgnoredMessageIdentity(params: {
  accountId: string;
  chatId: string | number;
  messageId: string;
}): string {
  return JSON.stringify([params.accountId, String(params.chatId), params.messageId]);
}

function telegramIgnoredMessageKey(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
  messageId: string;
}): string {
  const digest = Buffer.from(telegramIgnoredMessageIdentity(params), "utf8").toString("base64url");
  return `${params.scopeKey ? `${params.scopeKey}:` : ""}ignored-message:${digest}`;
}

function telegramIgnoredMediaGroupKey(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
  mediaGroupId: string;
}): string {
  const digest = Buffer.from(telegramIgnoredMediaGroupIdentity(params), "utf8").toString(
    "base64url",
  );
  return `${params.scopeKey ? `${params.scopeKey}:` : ""}ignored-media-group:${digest}`;
}

function readIgnoredMessageIds(params: {
  bucket: TelegramMessageCacheBucket;
  accountId: string;
  chatId: string | number;
}): Set<string> {
  const expectedAccountId = params.accountId;
  const expectedChatId = String(params.chatId);
  return new Set(
    Array.from(params.bucket.ignoredMessages, (identity) => {
      // SAFETY: ignored-message identities are created above as three-string JSON tuples.
      const parsed = JSON.parse(identity) as [string, string, string];
      return parsed[0] === expectedAccountId && parsed[1] === expectedChatId ? parsed[2] : "";
    }).filter(Boolean),
  );
}

function registerPrivacyIdentity(
  bucket: TelegramMessageCacheBucket,
  entry: { kind: "ignored-message" | "ignored-media-group"; identity: string },
): void {
  const key = `${entry.kind}\0${entry.identity}`;
  bucket.privacyIdentities.delete(key);
  bucket.privacyIdentities.set(key, entry);
  const target =
    entry.kind === "ignored-message" ? bucket.ignoredMessages : bucket.ignoredMediaGroups;
  target.delete(entry.identity);
  target.add(entry.identity);
  while (bucket.privacyIdentities.size > TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_MAX_ENTRIES) {
    const oldest = bucket.privacyIdentities.entries().next().value;
    if (!oldest) {
      break;
    }
    const [oldestKey, oldestEntry] = oldest;
    bucket.privacyIdentities.delete(oldestKey);
    const oldestTarget =
      oldestEntry.kind === "ignored-message" ? bucket.ignoredMessages : bucket.ignoredMediaGroups;
    oldestTarget.delete(oldestEntry.identity);
  }
}

function readIgnoredMediaGroupIds(params: {
  bucket: TelegramMessageCacheBucket;
  accountId: string;
  chatId: string | number;
}): Set<string> {
  const expectedAccountId = params.accountId;
  const expectedChatId = String(params.chatId);
  return new Set(
    Array.from(params.bucket.ignoredMediaGroups, (identity) => {
      // SAFETY: ignored-media-group identities are created above as three-string JSON tuples.
      const parsed = JSON.parse(identity) as [string, string, string];
      return parsed[0] === expectedAccountId && parsed[1] === expectedChatId ? parsed[2] : "";
    }).filter(Boolean),
  );
}

function detachReplyTargetsByPrivacy(
  msg: Message,
  params: {
    chatId: string | number;
    ignoredMessageIds: ReadonlySet<string>;
    ignoredMediaGroupIds: ReadonlySet<string>;
  },
): Message {
  const expectedChatId = String(params.chatId);
  return detachMatchingReplyTarget(msg, (reply, kind) => {
    if (
      kind === "external_reply" &&
      (reply.chat?.id == null || String(reply.chat.id) !== expectedChatId)
    ) {
      return false;
    }
    return (
      params.ignoredMessageIds.has(String(reply.message_id)) ||
      (typeof reply.media_group_id === "string" &&
        params.ignoredMediaGroupIds.has(reply.media_group_id))
    );
  });
}

function resolveReplyMessage(msg: Message): Message | undefined {
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  return msg.reply_to_message ?? externalReply;
}

function resolveEmbeddedReplyMessage(msg: Message): Message | undefined {
  return msg.reply_to_message;
}

type TelegramReplyTargetKind = "reply_to_message" | "external_reply";

function detachMatchingReplyTarget<T extends Message>(
  msg: T,
  matches: (reply: Message, kind: TelegramReplyTargetKind) => boolean,
  visited = new Set<string>(),
): T {
  let detached: T = msg;
  // SAFETY: Telegram can supply external_reply even though this grammY Message version omits it.
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  if (externalReply && matches(externalReply, "external_reply")) {
    detached = { ...detached };
    // SAFETY: the cloned Message preserves T while removing only Telegram's optional extension.
    delete (detached as MessageWithExternalReply).external_reply;
    // TextQuote belongs to the detached direct target on external replies too.
    delete detached.quote;
  }

  // Telegram external replies are a single, non-recursive envelope. Only an embedded
  // reply_to_message can carry a reply chain that needs recursive detachment.
  const replyMessage = msg.reply_to_message;
  if (!replyMessage) {
    return detached;
  }
  const replyId = String(replyMessage.message_id);
  if (visited.has(replyId)) {
    return detached;
  }
  visited.add(replyId);
  if (matches(replyMessage, "reply_to_message")) {
    const withoutReply = { ...detached };
    delete withoutReply.reply_to_message;
    // Telegram's TextQuote belongs to the direct reply target. Keeping it after
    // detaching an ignored reply would persist a second copy of the hidden text.
    delete withoutReply.quote;
    return withoutReply;
  }
  const detachedReply = detachMatchingReplyTarget(replyMessage, matches, visited);
  return detachedReply === replyMessage
    ? detached
    : Object.assign({}, detached, { reply_to_message: detachedReply });
}

function detachReplyTargetsById(
  msg: Message,
  messageIds: ReadonlySet<string>,
  chatId: string | number,
): Message {
  const expectedChatId = String(chatId);
  return detachMatchingReplyTarget(msg, (reply, kind) => {
    if (!messageIds.has(String(reply.message_id))) {
      return false;
    }
    if (kind === "reply_to_message") {
      return true;
    }
    // external_reply message numbers are chat-local. Missing or different chat identity must
    // fail closed so removing one chat's message cannot detach another chat's same-number reply.
    return reply.chat?.id != null && String(reply.chat.id) === expectedChatId;
  });
}

/**
 * Telegram embeds reply payloads. Keep an ignored target available to the live turn, but never
 * persist it (or a dangling replyToId) where cache hydration could restore it later.
 */
function detachIgnoredReplyTarget(
  msg: Message,
  botUsername: string | undefined,
  ignoreEnabled: boolean,
  ignoredMessageIds?: ReadonlySet<string>,
  ignoredMediaGroupIds?: ReadonlySet<string>,
): Message {
  if (!ignoreEnabled && !ignoredMessageIds?.size && !ignoredMediaGroupIds?.size) {
    return msg;
  }
  return detachMatchingReplyTarget(
    msg,
    (reply) =>
      (ignoreEnabled && resolveTelegramIgnoreDisposition(reply, botUsername) !== "keep") ||
      ignoredMessageIds?.has(String(reply.message_id)) === true ||
      (typeof reply.media_group_id === "string" &&
        ignoredMediaGroupIds?.has(reply.media_group_id) === true),
  );
}

export function isTelegramMessageFromCurrentBot(msg: Message, botUserId?: number): boolean {
  const currentBotUserId = parseStrictPositiveInteger(botUserId);
  if (currentBotUserId === undefined) {
    return msg.from?.is_bot === true;
  }
  return msg.from?.id === currentBotUserId || msg.sender_business_bot?.id === currentBotUserId;
}

function resolveMessageBody(msg: Message, preserveWhitespace: boolean): string | undefined {
  const text = getTelegramTextParts(msg).text;
  if (text.trim()) {
    return preserveWhitespace ? text : text.trim();
  }
  const location = extractTelegramLocation(msg);
  if (location) {
    return formatLocationText(location);
  }
  return resolveTelegramRichMessageBody(msg);
}

function resolveMessageTimestamp(msg: Message): number | undefined {
  const promptContextTimestamp = (msg as MessageWithPromptContextTimestamp)
    .openclaw_prompt_context_timestamp_ms;
  return typeof promptContextTimestamp === "number" && Number.isFinite(promptContextTimestamp)
    ? promptContextTimestamp
    : msg.date
      ? msg.date * 1000
      : undefined;
}

function normalizeMessageNode(
  msg: Message,
  params: {
    threadId?: number;
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
    resolvedMedia?: TelegramResolvedMedia;
    threadBinding?: TelegramMessageThreadBinding;
    botUsername?: string;
  },
): TelegramCachedMessageNode {
  const media = resolveTelegramPrimaryMedia(msg);
  const fileId = media?.fileRef.file_id;
  const forwardedFrom = normalizeForwardedContext(msg);
  const replyMessage = resolveReplyMessage(msg);
  const body = resolveMessageBody(msg, params.promptContextProjectionMarker !== undefined);
  const threadBinding = normalizeTelegramMessageThreadBinding(params.threadBinding);
  const threadId = parseTelegramMessageThreadId(threadBinding?.threadSpec.id ?? params.threadId);
  const timestamp = resolveMessageTimestamp(msg);
  return {
    sourceMessage: msg,
    messageId: String(msg.message_id),
    sender: buildSenderName(msg) ?? "unknown sender",
    ...(msg.from?.id != null ? { senderId: String(msg.from.id) } : {}),
    ...(msg.from?.username ? { senderUsername: msg.from.username } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(body ? { body } : {}),
    ...(media ? { mediaType: media.kind } : {}),
    ...(fileId ? { mediaRef: `telegram:file/${fileId}` } : {}),
    ...(replyMessage?.message_id != null ? { replyToId: String(replyMessage.message_id) } : {}),
    ...(forwardedFrom?.from ? { forwardedFrom: forwardedFrom.from } : {}),
    ...(forwardedFrom?.fromId ? { forwardedFromId: forwardedFrom.fromId } : {}),
    ...(forwardedFrom?.fromUsername ? { forwardedFromUsername: forwardedFrom.fromUsername } : {}),
    ...(forwardedFrom?.date ? { forwardedDate: forwardedFrom.date * 1000 } : {}),
    ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
    ...(params.promptContextProjectionMarker
      ? { promptContextProjectionMarker: params.promptContextProjectionMarker }
      : {}),
    ...(params.resolvedMedia ? { resolvedMedia: params.resolvedMedia } : {}),
    ...(threadBinding ? { threadBinding } : {}),
  };
}

function normalizeTelegramMessageThreadBinding(
  value: unknown,
): TelegramMessageThreadBinding | undefined {
  if (!isRecord(value) || value.kind !== "provider-observed-v1") {
    return undefined;
  }
  const threadSpec = value.threadSpec;
  if (!isRecord(threadSpec)) {
    return undefined;
  }
  const id = parseTelegramMessageThreadId(threadSpec.id);
  if (
    id === undefined ||
    (threadSpec.scope !== "direct-messages" &&
      threadSpec.scope !== "dm" &&
      threadSpec.scope !== "forum")
  ) {
    return undefined;
  }
  return { kind: "provider-observed-v1", threadSpec: { scope: threadSpec.scope, id } };
}

function createTelegramMessageThreadBinding(
  threadSpec: TelegramThreadSpec | undefined,
): TelegramMessageThreadBinding | undefined {
  return normalizeTelegramMessageThreadBinding({ kind: "provider-observed-v1", threadSpec });
}

export function hasProviderObservedTelegramThreadBinding(
  node: TelegramCachedMessageNode | null | undefined,
  threadId: unknown,
): boolean {
  const normalizedThreadId = parseTelegramMessageThreadId(threadId);
  return (
    normalizedThreadId !== undefined &&
    resolveProviderObservedTelegramThreadSpec(node)?.id === normalizedThreadId
  );
}

export function resolveProviderObservedTelegramThreadSpec(
  node: TelegramCachedMessageNode | null | undefined,
): TelegramMessageThreadBinding["threadSpec"] | undefined {
  return normalizeTelegramMessageThreadBinding(node?.threadBinding)?.threadSpec;
}

function normalizeMessageNodes(
  msg: Message,
  params: {
    threadId?: number;
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
    resolvedMedia?: TelegramResolvedMedia;
    threadBinding?: TelegramMessageThreadBinding;
    botUsername?: string;
    ignoreEnabled?: boolean;
    ignoredMessageIds?: ReadonlySet<string>;
    ignoredMediaGroupIds?: ReadonlySet<string>;
  },
): TelegramCachedMessageObservation[] {
  const observations: TelegramCachedMessageObservation[] = [];
  const visited = new Set<string>();
  const nodeThreadId = (node: TelegramCachedMessageNode) =>
    parseTelegramMessageThreadId(node.threadId);
  const visit = (
    observed: Message,
    inheritedThreadId: number | undefined,
    mode: TelegramMessageObservationMode,
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker,
    threadBinding?: TelegramMessageThreadBinding,
    resolvedMedia?: TelegramResolvedMedia,
  ) => {
    const message = detachIgnoredReplyTarget(
      observed,
      params.botUsername,
      params.ignoreEnabled === true,
      params.ignoredMessageIds,
      params.ignoredMediaGroupIds,
    );
    const embeddedThreadId = parseTelegramMessageThreadId(
      (message as { message_thread_id?: unknown }).message_thread_id,
    );
    const inheritedThread = parseTelegramMessageThreadId(inheritedThreadId);
    const observedBinding = normalizeTelegramMessageThreadBinding(threadBinding);
    const threadId =
      mode === "authoritative"
        ? (observedBinding?.threadSpec.id ?? inheritedThread ?? embeddedThreadId)
        : (embeddedThreadId ?? inheritedThread);
    const matchingBinding =
      observedBinding?.threadSpec.id === threadId ? observedBinding : undefined;
    const node = normalizeMessageNode(message, {
      ...(threadId !== undefined ? { threadId } : {}),
      ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
      ...(resolvedMedia ? { resolvedMedia } : {}),
      ...(matchingBinding ? { threadBinding: matchingBinding } : {}),
    });
    if (visited.has(node.messageId)) {
      return;
    }
    visited.add(node.messageId);
    const replyMessage = resolveEmbeddedReplyMessage(message);
    if (replyMessage?.message_id != null) {
      visit(
        replyMessage,
        nodeThreadId(node) ?? inheritedThreadId,
        "partial",
        undefined,
        node.threadBinding,
        undefined,
      );
    }
    observations.push({ node, mode });
  };
  visit(
    msg,
    params.threadId,
    "authoritative",
    params.promptContextProjectionMarker,
    params.threadBinding,
    params.resolvedMedia,
  );
  return observations;
}

function parseSafeMessageId(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseStrictPositiveInteger(value);
}

function parsePersistedCacheValue(key: string, value: unknown) {
  if (
    !isRecord(value) ||
    (value.version !== undefined && value.version !== TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION)
  ) {
    return [];
  }
  const separatorIndex = key.lastIndexOf(":");
  if (separatorIndex === -1 || !isTelegramMessageCacheSourceMessage(value.sourceMessage)) {
    return [];
  }
  const threadId = parseTelegramMessageThreadId(value.threadId);
  const botUserId = parseStrictPositiveInteger(value.botUserId);
  const promptContextProjectionMarker =
    value.version === TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION &&
    isTelegramMessageFromCurrentBot(value.sourceMessage, botUserId)
      ? parseTelegramPromptContextProjection(value.promptContextProjection)
      : undefined;
  const threadBinding =
    value.version === TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION
      ? normalizeTelegramMessageThreadBinding(value.threadBinding)
      : undefined;
  const resolvedMedia = parseTelegramResolvedMedia(value.resolvedMedia);
  return normalizeMessageNodes(value.sourceMessage, {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
    ...(resolvedMedia ? { resolvedMedia } : {}),
  }).map(({ node, mode }) => ({
    key: `${key.slice(0, separatorIndex + 1)}${node.messageId}`,
    node,
    mode,
  }));
}

function trimMessages(messages: Map<string, TelegramCachedMessageNode>, maxMessages: number): void {
  while (messages.size > maxMessages) {
    const oldest = messages.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    messages.delete(oldest);
  }
}

function mergeTelegramSourceMessage(existing: Message, incoming: Message): Message {
  const existingReply = resolveEmbeddedReplyMessage(existing);
  const incomingReply = resolveEmbeddedReplyMessage(incoming);
  if (existingReply?.message_id != null && incomingReply?.message_id === existingReply.message_id) {
    return Object.assign({}, existing, incoming, {
      reply_to_message: mergeTelegramSourceMessage(
        existingReply,
        incomingReply,
      ) as TelegramEmbeddedReplyMessage,
    }) as Message;
  }
  return Object.assign({}, existing, incoming);
}

function mergeAuthoritativeTelegramSourceMessage(existing: Message, incoming: Message): Message {
  const existingReply = resolveEmbeddedReplyMessage(existing);
  const incomingReply = resolveEmbeddedReplyMessage(incoming);
  if (existingReply?.message_id != null && incomingReply?.message_id === existingReply.message_id) {
    return Object.assign({}, incoming, {
      reply_to_message: mergeTelegramSourceMessage(
        existingReply,
        incomingReply,
      ) as TelegramEmbeddedReplyMessage,
    }) as Message;
  }
  return incoming;
}

function mergeCachedMessageNode(
  existing: TelegramCachedMessageNode,
  incoming: TelegramCachedMessageNode,
  mode: TelegramMessageObservationMode,
): TelegramCachedMessageNode {
  const mergedSourceMessage =
    mode === "authoritative"
      ? mergeAuthoritativeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage)
      : mergeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage);
  const syntheticOutboundFrom =
    existing.senderId === "0" && incoming.sourceMessage.sender_chat
      ? existing.sourceMessage.from
      : undefined;
  // sender_chat pairs with a fake `from`; preserve our outbound-only id=0 sentinel.
  const sourceMessage = syntheticOutboundFrom
    ? ({ ...mergedSourceMessage, from: syntheticOutboundFrom } as Message)
    : mergedSourceMessage;
  const promptContextProjectionMarker =
    incoming.promptContextProjectionMarker ?? existing.promptContextProjectionMarker;
  const threadBinding =
    normalizeTelegramMessageThreadBinding(incoming.threadBinding) ??
    normalizeTelegramMessageThreadBinding(existing.threadBinding);
  const threadId = parseTelegramMessageThreadId(
    threadBinding?.threadSpec.id ?? incoming.threadId ?? existing.threadId,
  );
  const primaryMedia = resolveTelegramPrimaryMedia(sourceMessage);
  const resolvedMedia =
    existing.resolvedMedia?.fileUniqueId === primaryMedia?.fileRef.file_unique_id
      ? existing.resolvedMedia
      : undefined;
  return normalizeMessageNode(sourceMessage, {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
    ...(resolvedMedia ? { resolvedMedia } : {}),
  });
}

function upsertCachedMessageNode(params: {
  messages: Map<string, TelegramCachedMessageNode>;
  key: string;
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
}): TelegramCachedMessageNode {
  const existing = params.messages.get(params.key);
  const node = existing ? mergeCachedMessageNode(existing, params.node, params.mode) : params.node;
  params.messages.delete(params.key);
  params.messages.set(params.key, node);
  return node;
}

function resolveDefaultPersistentStore(): TelegramMessageCachePersistentStore | undefined {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    return runtime.state.openKeyedStore<PersistedTelegramMessageCacheEntry>({
      namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
    });
  } catch (error) {
    logVerbose(`telegram: failed to open message cache plugin state: ${String(error)}`);
    return undefined;
  }
}

function resolveDefaultPrivacyStore(): TelegramMessagePrivacyPersistentStore | undefined {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    return runtime.state.openKeyedStore<PersistedTelegramMessagePrivacyEntry>({
      namespace: TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_MAX_ENTRIES,
    });
  } catch (error) {
    logVerbose(`telegram: failed to open message privacy state: ${String(error)}`);
    return undefined;
  }
}

function resolveMessageCacheBucket(params: {
  bucketKey?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
  privacyStore?: TelegramMessagePrivacyPersistentStore;
}): TelegramMessageCacheBucket {
  const { bucketKey } = params;
  if (!bucketKey) {
    return {
      messages: new Map<string, TelegramCachedMessageNode>(),
      ignoredMessages: new Set<string>(),
      ignoredMediaGroups: new Set<string>(),
      privacyIdentities: new Map(),
      hydrated: true,
      ...(params.privacyStore ? { privacyStore: params.privacyStore } : {}),
    };
  }
  const persistedMessageCacheBuckets = getPersistedMessageCacheBuckets();
  const existing = persistedMessageCacheBuckets.get(bucketKey);
  if (existing) {
    existing.persistentStore = params.persistentStore ?? existing.persistentStore;
    existing.privacyStore = params.privacyStore ?? existing.privacyStore;
    return existing;
  }
  const bucket = {
    messages: new Map<string, TelegramCachedMessageNode>(),
    ignoredMessages: new Set<string>(),
    ignoredMediaGroups: new Set<string>(),
    privacyIdentities: new Map(),
    hydrated: false,
    ...(params.persistentStore ? { persistentStore: params.persistentStore } : {}),
    ...(params.privacyStore ? { privacyStore: params.privacyStore } : {}),
  };
  persistedMessageCacheBuckets.set(bucketKey, bucket);
  return bucket;
}

async function hydrateMessageCacheBucket(
  bucket: TelegramMessageCacheBucket,
  maxMessages: number,
  scopeKey?: string,
): Promise<void> {
  if (bucket.hydrated) {
    return;
  }
  if (bucket.hydratePromise) {
    await bucket.hydratePromise;
    return;
  }
  bucket.hydratePromise = (async () => {
    let storeEntries: Array<{ key: string; value: unknown }> = [];
    let privacyEntries: Array<{ key: string; value: unknown }>;
    try {
      storeEntries = (await bucket.persistentStore?.entries()) ?? [];
    } catch (error) {
      logVerbose(`telegram: failed to hydrate message cache from plugin state: ${String(error)}`);
    }
    try {
      privacyEntries = (await bucket.privacyStore?.entries()) ?? [];
    } catch (error) {
      logVerbose(`telegram: failed to hydrate message privacy state: ${String(error)}`);
      // Message rows are unsafe to expose when their authoritative revocations cannot be read.
      throw error;
    }
    const scopedStoreEntries = scopeKey
      ? storeEntries.filter(({ key }) => key.startsWith(`${scopeKey}:`))
      : storeEntries;
    const scopedPrivacyEntries = scopeKey
      ? privacyEntries.filter(({ key }) => key.startsWith(`${scopeKey}:`))
      : privacyEntries;

    const ignoredMessages = scopedPrivacyEntries.flatMap(({ value }) => {
      const ignored = parsePersistedTelegramIgnoredMessage(value);
      return ignored ? [ignored] : [];
    });
    const ignoredMediaGroups = [
      ...scopedPrivacyEntries,
      // Read the shipped legacy location so existing revocations survive the namespace split.
      ...scopedStoreEntries,
    ].flatMap(({ value }) => {
      const ignored = parsePersistedTelegramIgnoredMediaGroup(value);
      return ignored ? [ignored] : [];
    });
    for (const ignored of ignoredMessages) {
      registerPrivacyIdentity(bucket, {
        kind: "ignored-message",
        identity: telegramIgnoredMessageIdentity(ignored),
      });
    }
    for (const ignored of ignoredMediaGroups) {
      registerPrivacyIdentity(bucket, {
        kind: "ignored-media-group",
        identity: telegramIgnoredMediaGroupIdentity(ignored),
      });
    }

    // Migrate legacy album markers into the independent privacy LRU opportunistically.
    if (bucket.privacyStore) {
      for (const { key, value } of scopedStoreEntries) {
        const ignored = parsePersistedTelegramIgnoredMediaGroup(value);
        if (!ignored) {
          continue;
        }
        try {
          await bucket.privacyStore.register(
            telegramIgnoredMediaGroupKey({ scopeKey, ...ignored }),
            ignored,
          );
          await bucket.persistentStore?.delete(key);
        } catch (error) {
          logVerbose(`telegram: failed to migrate ignored album privacy state: ${String(error)}`);
        }
      }
    }

    for (const { key, value } of scopedStoreEntries) {
      if (parsePersistedTelegramIgnoredMediaGroup(value)) {
        continue;
      }
      if (!isRecord(value) || !isTelegramMessageCacheSourceMessage(value.sourceMessage)) {
        continue;
      }
      const relevantIgnoredMessages = ignoredMessages.filter((ignored) =>
        key.startsWith(
          telegramMessageCacheKeyPrefix({
            scopeKey,
            accountId: ignored.accountId,
            chatId: ignored.chatId,
          }),
        ),
      );
      const relevantIgnoredMediaGroups = ignoredMediaGroups.filter((ignored) =>
        key.startsWith(
          telegramMessageCacheKeyPrefix({
            scopeKey,
            accountId: ignored.accountId,
            chatId: ignored.chatId,
          }),
        ),
      );
      const ignoredMessageIds = new Set(
        relevantIgnoredMessages.map((ignored) => ignored.messageId),
      );
      const ignoredMediaGroupIds = new Set(
        relevantIgnoredMediaGroups.map((ignored) => ignored.mediaGroupId),
      );
      const sourceMessage = value.sourceMessage;
      const sourceIsIgnored =
        ignoredMessageIds.has(String(sourceMessage.message_id)) ||
        (typeof sourceMessage.media_group_id === "string" &&
          ignoredMediaGroupIds.has(sourceMessage.media_group_id));
      if (sourceIsIgnored) {
        try {
          await bucket.persistentStore?.delete(key);
        } catch (error) {
          logVerbose(`telegram: failed to purge ignored hydrated message: ${String(error)}`);
        }
        continue;
      }
      const detachedSourceMessage = detachReplyTargetsByPrivacy(sourceMessage, {
        chatId: sourceMessage.chat.id,
        ignoredMessageIds,
        ignoredMediaGroupIds,
      });
      if (detachedSourceMessage !== sourceMessage) {
        try {
          const scrubbedValue = {
            ...value,
            sourceMessage: detachedSourceMessage,
          };
          await bucket.persistentStore?.register(
            key,
            // SAFETY: hydration validated the source Message; replacement preserves other fields.
            scrubbedValue as PersistedTelegramMessageCacheEntry,
          );
        } catch (error) {
          logVerbose(`telegram: failed to scrub ignored hydrated reply: ${String(error)}`);
        }
      }
      for (const entry of parsePersistedCacheValue(key, {
        ...value,
        sourceMessage: detachedSourceMessage,
      })) {
        upsertCachedMessageNode({
          messages: bucket.messages,
          key: entry.key,
          node: entry.node,
          mode: entry.mode,
        });
        trimMessages(bucket.messages, maxMessages);
      }
    }
    bucket.hydrated = true;
  })().finally(() => {
    bucket.hydratePromise = undefined;
  });
  await bucket.hydratePromise;
}

async function persistCachedNode(params: {
  bucket: TelegramMessageCacheBucket;
  key: string;
  node: TelegramCachedMessageNode;
  botUserId?: number;
}): Promise<void> {
  const { persistentStore } = params.bucket;
  if (!persistentStore) {
    return;
  }
  try {
    const marker = params.node.promptContextProjectionMarker;
    const promptContextProjection =
      marker?.kind === "valid"
        ? marker.projection
        : marker
          ? { transcriptMessageId: marker.transcriptMessageId }
          : undefined;
    await persistentStore.register(params.key, {
      version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
      sourceMessage: params.node.sourceMessage,
      ...(params.botUserId !== undefined ? { botUserId: params.botUserId } : {}),
      ...(promptContextProjection ? { promptContextProjection } : {}),
      ...(params.node.resolvedMedia ? { resolvedMedia: params.node.resolvedMedia } : {}),
      ...(params.node.threadBinding ? { threadBinding: params.node.threadBinding } : {}),
      ...(params.node.threadId ? { threadId: params.node.threadId } : {}),
    });
  } catch (error) {
    logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
    const marker = params.node.promptContextProjectionMarker;
    if (marker) {
      params.node.promptContextProjectionMarker = {
        kind: "invalid",
        transcriptMessageId:
          marker.kind === "valid"
            ? marker.projection.transcriptMessageId
            : marker.transcriptMessageId,
      };
      throw error;
    }
  }
}

export function createTelegramMessageCache(params?: {
  maxMessages?: number;
  scope?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
  privacyStore?: TelegramMessagePrivacyPersistentStore;
  bucketKey?: string;
  botUsername?: string;
  ignoreEnabled?: boolean;
}): TelegramMessageCache {
  const botUsername = params?.botUsername;
  const ignoreEnabled = params?.ignoreEnabled !== false;
  const persistentStore = params?.persistentStore ?? resolveDefaultPersistentStore();
  const privacyStore = params?.privacyStore ?? resolveDefaultPrivacyStore();
  const maxMessages =
    params?.maxMessages ??
    (persistentStore ? TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES : DEFAULT_MAX_MESSAGES);
  const scopeKey =
    persistentStore || privacyStore
      ? resolveTelegramMessageCachePersistentScopeKey(params?.scope ?? "default")
      : undefined;
  const bucketKey =
    params?.bucketKey ??
    (persistentStore || privacyStore ? `${PERSISTENT_BUCKET_KEY}:${scopeKey}` : undefined);
  const bucket = resolveMessageCacheBucket({
    bucketKey,
    ...(persistentStore ? { persistentStore } : {}),
    ...(privacyStore ? { privacyStore } : {}),
  });
  const { messages } = bucket;

  const isIgnored: TelegramMessageCache["isIgnored"] = async ({
    accountId,
    chatId,
    messageId,
    mediaGroupId,
  }) => {
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
    if (
      bucket.ignoredMessages.has(telegramIgnoredMessageIdentity({ accountId, chatId, messageId }))
    ) {
      return true;
    }
    return mediaGroupId
      ? bucket.ignoredMediaGroups.has(
          telegramIgnoredMediaGroupIdentity({ accountId, chatId, mediaGroupId }),
        )
      : false;
  };

  const get: TelegramMessageCache["get"] = async ({ accountId, chatId, messageId }) => {
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
    if (!messageId) {
      return null;
    }
    const key = telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId });
    const entry = messages.get(key);
    if (!entry) {
      return null;
    }
    messages.delete(key);
    messages.set(key, entry);
    return entry;
  };

  const listChatMessages = async (paramsLocal: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
  }) => {
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
    const prefix = telegramMessageCacheKeyPrefix({ scopeKey, ...paramsLocal });
    const normalizedThreadId = parseTelegramMessageThreadId(paramsLocal.threadId);
    if (paramsLocal.threadId != null && normalizedThreadId === undefined) {
      return [];
    }
    const threadId = normalizedThreadId !== undefined ? String(normalizedThreadId) : undefined;
    return Array.from(messages, ([key, node]) => ({ key, node }))
      .filter(({ key, node }) => {
        if (!key.startsWith(prefix)) {
          return false;
        }
        return threadId === undefined || node.threadId === threadId;
      })
      .map(({ node }) => node)
      .toSorted(compareCachedMessageNodes);
  };

  const detachCachedReplyDescendants = (
    prefix: string,
    messageIds: ReadonlySet<string>,
    chatId: string | number,
  ): boolean => {
    let removed = false;
    for (const [cachedKey, node] of messages) {
      if (!cachedKey.startsWith(prefix)) {
        continue;
      }
      const sourceMessage = detachReplyTargetsById(node.sourceMessage, messageIds, chatId);
      if (sourceMessage === node.sourceMessage) {
        continue;
      }
      const threadId = parseTelegramMessageThreadId(node.threadId);
      messages.set(
        cachedKey,
        normalizeMessageNode(sourceMessage, {
          ...(threadId !== undefined ? { threadId } : {}),
          ...(node.promptContextProjectionMarker
            ? { promptContextProjectionMarker: node.promptContextProjectionMarker }
            : {}),
          ...(node.resolvedMedia ? { resolvedMedia: node.resolvedMedia } : {}),
          ...(node.threadBinding ? { threadBinding: node.threadBinding } : {}),
        }),
      );
      removed = true;
    }
    return removed;
  };

  return {
    record: async ({
      accountId,
      botUserId,
      botUsername: observedBotUsername,
      chatId,
      msg,
      promptContextProjection,
      providerObservedThread,
      threadId,
    }) => {
      const effectiveBotUsername = observedBotUsername ?? botUsername;
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const ignoredMessageIds = readIgnoredMessageIds({ bucket, accountId, chatId });
      const ignoredMediaGroupIds = readIgnoredMediaGroupIds({ bucket, accountId, chatId });
      const threadBinding = createTelegramMessageThreadBinding(providerObservedThread);
      const observations = normalizeMessageNodes(msg, {
        threadId,
        ...(promptContextProjection && isTelegramMessageFromCurrentBot(msg, botUserId)
          ? {
              promptContextProjectionMarker: {
                kind: "valid",
                projection: promptContextProjection,
              },
            }
          : {}),
        ...(threadBinding ? { threadBinding } : {}),
        ...(effectiveBotUsername ? { botUsername: effectiveBotUsername } : {}),
        ignoreEnabled,
        ignoredMessageIds,
        ignoredMediaGroupIds,
      });
      const currentObservation = observations.at(-1)!;
      let recordedEntry = currentObservation.node;
      for (const { node, mode } of observations) {
        const { messageId } = node;
        if (
          ignoredMessageIds.has(messageId) ||
          (typeof node.sourceMessage.media_group_id === "string" &&
            ignoredMediaGroupIds.has(node.sourceMessage.media_group_id))
        ) {
          continue;
        }
        const key = telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId });
        const cachedNode = upsertCachedMessageNode({ messages, key, node, mode });
        if (messageId === currentObservation.node.messageId) {
          recordedEntry = cachedNode;
        }
        trimMessages(messages, maxMessages);
        await persistCachedNode({
          bucket,
          key,
          node: cachedNode,
          ...(botUserId !== undefined ? { botUserId } : {}),
        });
      }
      return recordedEntry;
    },
    recordResolvedMedia: async ({ accountId, botUserId, chatId, messageId, media }) => {
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const key = telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId });
      const node = messages.get(key);
      if (!node) {
        throw new Error(`Telegram message ${messageId} was not recorded before media resolution`);
      }
      const fileUniqueId = resolveTelegramPrimaryMedia(node.sourceMessage)?.fileRef.file_unique_id;
      if (fileUniqueId !== media.fileUniqueId) {
        throw new Error(`Telegram message ${messageId} media changed during resolution`);
      }
      // Runtime downloads carry private paths/names; cache only the existing persisted projection.
      const { path: _path, fileName: _fileName, ...resolvedMedia } = media;
      const resolvedNode = { ...node, resolvedMedia };
      messages.delete(key);
      messages.set(key, resolvedNode);
      await persistCachedNode({
        bucket,
        key,
        node: resolvedNode,
        ...(botUserId !== undefined ? { botUserId } : {}),
      });
    },
    remove: async ({ accountId, chatId, messageId, mediaGroupId }) => {
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const prefix = telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId });
      const messageIds = new Set([messageId]);
      const ignoredMessageIdentity = telegramIgnoredMessageIdentity({
        accountId,
        chatId,
        messageId,
      });
      const ignoredMediaGroupIdentity = mediaGroupId
        ? telegramIgnoredMediaGroupIdentity({ accountId, chatId, mediaGroupId })
        : undefined;
      // Revoke live context synchronously before any durable I/O yields.
      if (ignoredMediaGroupIdentity) {
        registerPrivacyIdentity(bucket, {
          kind: "ignored-media-group",
          identity: ignoredMediaGroupIdentity,
        });
      }
      registerPrivacyIdentity(bucket, {
        kind: "ignored-message",
        identity: ignoredMessageIdentity,
      });
      // Album members are separate reply nodes but one prompt event. Ignoring any member must
      // remove the whole album and every embedded reply path that could restore it.
      if (mediaGroupId) {
        for (const [cachedKey, node] of messages) {
          if (cachedKey.startsWith(prefix) && node.sourceMessage.media_group_id === mediaGroupId) {
            messageIds.add(node.messageId);
          }
        }
      }
      const removeFromMemory = () => {
        const initialSize = messages.size;
        for (const targetId of messageIds) {
          messages.delete(
            telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId: targetId }),
          );
        }
        return (
          detachCachedReplyDescendants(prefix, messageIds, chatId) || messages.size !== initialSize
        );
      };
      // No concurrent prompt-context read may observe an authorized revocation while its durable
      // tombstone is waiting on storage. A second pass below covers album ids found only on disk.
      const removedFromMemory = removeFromMemory();
      try {
        let removed = removedFromMemory;
        if (bucket.privacyStore) {
          if (mediaGroupId) {
            await bucket.privacyStore.register(
              telegramIgnoredMediaGroupKey({ scopeKey, accountId, chatId, mediaGroupId }),
              {
                version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
                kind: "ignored-media-group",
                accountId,
                chatId: String(chatId),
                mediaGroupId,
              },
            );
            removed = true;
          }
          await bucket.privacyStore.register(
            telegramIgnoredMessageKey({ scopeKey, accountId, chatId, messageId }),
            {
              version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
              kind: "ignored-message",
              accountId,
              chatId: String(chatId),
              messageId,
            },
          );
          removed = true;
        }
        if (!bucket.persistentStore) {
          return removeFromMemory() || removed;
        }
        const persistedEntries = await bucket.persistentStore.entries();
        if (mediaGroupId) {
          for (const { key: persistedKey, value } of persistedEntries) {
            if (!persistedKey.startsWith(prefix) || !isRecord(value)) {
              continue;
            }
            const sourceMessage = value.sourceMessage;
            if (
              isTelegramMessageCacheSourceMessage(sourceMessage) &&
              sourceMessage.media_group_id === mediaGroupId
            ) {
              messageIds.add(String(sourceMessage.message_id));
            }
          }
        }
        const targetKeys = new Set(
          Array.from(messageIds, (targetId) =>
            telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId: targetId }),
          ),
        );
        const descendantKeys = persistedEntries
          .filter(({ key: persistedKey, value }) => {
            if (
              targetKeys.has(persistedKey) ||
              !persistedKey.startsWith(prefix) ||
              !isRecord(value)
            ) {
              return false;
            }
            const sourceMessage = value.sourceMessage;
            return (
              isTelegramMessageCacheSourceMessage(sourceMessage) &&
              detachReplyTargetsById(sourceMessage, messageIds, chatId) !== sourceMessage
            );
          })
          .map(({ key: persistedKey }) => persistedKey);
        for (const descendantKey of descendantKeys) {
          const current = await bucket.persistentStore.lookup(descendantKey);
          if (
            !current ||
            !("sourceMessage" in current) ||
            !isTelegramMessageCacheSourceMessage(current.sourceMessage)
          ) {
            continue;
          }
          const sourceMessage = detachReplyTargetsById(current.sourceMessage, messageIds, chatId);
          if (sourceMessage === current.sourceMessage) {
            continue;
          }
          await bucket.persistentStore.register(descendantKey, { ...current, sourceMessage });
          removed = true;
        }
        for (const targetKey of targetKeys) {
          removed = (await bucket.persistentStore.delete(targetKey)) || removed;
        }

        return removeFromMemory() || removed;
      } catch (error) {
        logVerbose(`telegram: failed to remove message from persistent cache: ${String(error)}`);
        throw error;
      }
    },
    isIgnored,
    get,
    recentBefore: async ({ accountId, chatId, messageId, threadId, limit }) => {
      if (!messageId || limit <= 0) {
        return [];
      }
      const targetId = parseSafeMessageId(messageId);
      if (targetId === undefined) {
        return [];
      }
      return (await listChatMessages({ accountId, chatId, threadId }))
        .filter((entry) => {
          const entryId = parseSafeMessageId(entry.messageId);
          return entryId !== undefined && entryId < targetId;
        })
        .slice(-limit);
    },
    around: async ({ accountId, chatId, messageId, threadId, before, after }) => {
      if (!messageId) {
        return [];
      }
      const entries = await listChatMessages({ accountId, chatId, threadId });
      const targetIndex = entries.findIndex((entry) => entry.messageId === messageId);
      if (targetIndex === -1) {
        return [];
      }
      return entries.slice(
        Math.max(0, targetIndex - Math.max(0, before)),
        targetIndex + Math.max(0, after) + 1,
      );
    },
    latestMatchingAtOrBefore: async ({ accountId, chatId, messageId, threadId, matches }) => {
      if (!messageId) {
        return null;
      }
      const targetId = parseSafeMessageId(messageId);
      if (targetId === undefined) {
        return null;
      }
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const prefix = telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId });
      const normalizedThreadId = parseTelegramMessageThreadId(threadId);
      if (threadId != null && normalizedThreadId === undefined) {
        return null;
      }
      const normalizedThread =
        normalizedThreadId !== undefined ? String(normalizedThreadId) : undefined;
      let latest: TelegramCachedMessageNode | null = null;
      for (const [key, entry] of messages) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        if (normalizedThread !== undefined && entry.threadId !== normalizedThread) {
          continue;
        }
        const entryId = parseSafeMessageId(entry.messageId);
        if (entryId === undefined || entryId > targetId || !matches(entry)) {
          continue;
        }
        if (!latest || compareCachedMessageNodes(entry, latest) > 0) {
          latest = entry;
        }
      }
      return latest;
    },
  };
}

function compareCachedMessageNodes(
  left: TelegramCachedMessageNode,
  right: TelegramCachedMessageNode,
) {
  const leftId = parseSafeMessageId(left.messageId);
  const rightId = parseSafeMessageId(right.messageId);
  if (leftId !== undefined && rightId !== undefined) {
    return leftId - rightId;
  }
  return (left.messageId ?? "").localeCompare(right.messageId ?? "");
}

const SESSION_BOUNDARY_COMMAND_RE = /^\/(?:new|reset)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const SOFT_RESET_COMMAND_RE = /^\/reset(?:@[A-Za-z0-9_]+)?\s+soft(?:\s|$)/i;

function isTelegramSessionBoundaryCommandText(text: string | undefined): boolean {
  const body = text?.trim();
  return Boolean(
    body && SESSION_BOUNDARY_COMMAND_RE.test(body) && !SOFT_RESET_COMMAND_RE.test(body),
  );
}

function isSessionBoundaryCommandNode(node: TelegramCachedMessageNode): boolean {
  return isTelegramSessionBoundaryCommandText(node.body);
}

function isAfterSessionBoundary(
  node: TelegramCachedMessageNode,
  boundary?: TelegramCachedMessageNode,
): boolean {
  if (!boundary) {
    return true;
  }
  const nodeId = parseSafeMessageId(node.messageId);
  const boundaryId = parseSafeMessageId(boundary.messageId);
  if (nodeId !== undefined && boundaryId !== undefined) {
    return nodeId > boundaryId;
  }
  if (
    typeof node.timestamp === "number" &&
    Number.isFinite(node.timestamp) &&
    typeof boundary.timestamp === "number" &&
    Number.isFinite(boundary.timestamp)
  ) {
    return node.timestamp > boundary.timestamp;
  }
  return true;
}

function normalizeSessionBoundaryTimestamp(timestampMs?: number): number | undefined {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return undefined;
  }
  return Math.floor(timestampMs / 1000) * 1000;
}

function isAtOrAfterSessionBoundaryTimestamp(
  node: TelegramCachedMessageNode,
  boundaryTimestampMs?: number,
): boolean {
  if (boundaryTimestampMs === undefined) {
    return true;
  }
  return typeof node.timestamp !== "number" || !Number.isFinite(node.timestamp)
    ? true
    : node.timestamp >= boundaryTimestampMs;
}

async function resolveSessionBoundaryNode(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  messageId?: string;
  threadId?: number;
}): Promise<TelegramCachedMessageNode | undefined> {
  if (!params.messageId) {
    return undefined;
  }
  return (
    (await params.cache.latestMatchingAtOrBefore({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      matches: isSessionBoundaryCommandNode,
    })) ?? undefined
  );
}

/**
 * Hard cap on reply-chain nodes rendered into the prompt. Model-visible context
 * must be bounded; every producer that appends chain entries shares this ceiling
 * so a busy chat cannot grow the turn past its budget.
 */
export const TELEGRAM_REPLY_CHAIN_MAX_DEPTH = 4;

export async function buildTelegramReplyChain(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  msg: Message;
  maxDepth?: number;
}): Promise<TelegramCachedMessageNode[]> {
  const replyMessage = resolveReplyMessage(params.msg);
  if (!replyMessage?.message_id) {
    return [];
  }
  const maxDepth = params.maxDepth ?? TELEGRAM_REPLY_CHAIN_MAX_DEPTH;
  const visited = new Set<string>();
  const chain: TelegramCachedMessageNode[] = [];
  let current: TelegramCachedMessageNode | null =
    (await params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: String(replyMessage.message_id),
    })) ?? normalizeMessageNode(replyMessage, {});

  while (current?.messageId && chain.length < maxDepth && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    chain.push(current);
    current = await params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: current.replyToId,
    });
  }

  return chain;
}

export async function buildTelegramConversationContext(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  messageId?: string;
  threadId?: number;
  replyChainNodes: TelegramCachedMessageNode[];
  recentLimit: number;
  replyTargetWindowSize: number;
  minTimestampMs?: number;
  includeNode?: (node: TelegramCachedMessageNode, flags?: { replyTarget?: boolean }) => boolean;
}): Promise<TelegramConversationContextNode[]> {
  const selected = new Map<string, TelegramConversationContextNode>();
  const replyTargetIds = new Set<string>();
  const sessionBoundary = await resolveSessionBoundaryNode(params);
  const sessionBoundaryTimestamp = normalizeSessionBoundaryTimestamp(params.minTimestampMs);
  const addNode = (node: TelegramCachedMessageNode, flags?: { replyTarget?: boolean }) => {
    if (!node.messageId || node.messageId === params.messageId) {
      return false;
    }
    if (!isAfterSessionBoundary(node, sessionBoundary)) {
      return false;
    }
    if (!isAtOrAfterSessionBoundaryTimestamp(node, sessionBoundaryTimestamp)) {
      return false;
    }
    if (params.includeNode && !params.includeNode(node, flags)) {
      return false;
    }
    const existing = selected.get(node.messageId);
    const isReplyTarget = existing?.isReplyTarget === true || flags?.replyTarget === true;
    selected.set(node.messageId, {
      node: existing?.node ?? node,
      isReplyTarget: isReplyTarget ? true : undefined,
    });
    return true;
  };
  const addReplyTargetWindow = async (messageId: string) => {
    replyTargetIds.add(messageId);
    for (const node of await params.cache.around({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      before: params.replyTargetWindowSize,
      after: params.replyTargetWindowSize,
    })) {
      addNode(node, { replyTarget: node.messageId === messageId });
    }
  };

  const currentWindow = await params.cache.recentBefore({
    accountId: params.accountId,
    chatId: params.chatId,
    messageId: params.messageId,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    limit: params.recentLimit,
  });
  for (const node of currentWindow) {
    const added = addNode(node);
    if (added && node.replyToId) {
      await addReplyTargetWindow(node.replyToId);
    }
  }

  for (const [index, node] of params.replyChainNodes.entries()) {
    const added = addNode(node, { replyTarget: index === 0 });
    if (added && index === 0 && node.messageId) {
      await addReplyTargetWindow(node.messageId);
    }
    if (added && node.replyToId) {
      replyTargetIds.add(node.replyToId);
    }
  }

  for (const messageId of replyTargetIds) {
    const node = await params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId,
    });
    if (node) {
      addNode(node, { replyTarget: true });
    }
  }

  return Array.from(selected.values()).toSorted((left, right) =>
    compareCachedMessageNodes(left.node, right.node),
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
