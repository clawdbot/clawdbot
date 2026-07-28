// Telegram plugin module implements message cache behavior.
import { createHash } from "node:crypto";
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
} from "./bot/helpers.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import {
  parseTelegramPromptContextProjection,
  type TelegramPromptContextProjection,
  type TelegramPromptContextProjectionMarker,
  type TelegramPromptContextSource,
} from "./prompt-context-projection.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

export type TelegramReplyChainEntry = NonNullable<MsgContext["ReplyChain"]>[number] & {
  mediaKind?: TelegramMediaKind;
};

export type TelegramCachedMessageNode = Omit<TelegramReplyChainEntry, "messageId"> & {
  messageId: string;
  sourceMessage: Message;
  promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
  threadBinding?: TelegramMessageThreadBinding;
};

// This marker is a provider fact, never an inference from invocation origin or
// a legacy threadId. Delegated mutations may rely on it after cache hydration.
type TelegramMessageThreadBinding = {
  kind: "provider-observed-v1";
  threadId: string;
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
    promptContextProjection?: TelegramPromptContextProjection;
    /** Set only while recording an authenticated provider event or response. */
    providerObservedThreadId?: number;
    threadId?: number;
  }) => Promise<TelegramCachedMessageNode>;
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
  hydrated: boolean;
  hydratePromise?: Promise<void>;
  persistentStore?: TelegramMessageCachePersistentStore;
};

type TelegramMessageObservationMode = "authoritative" | "partial";

type TelegramCachedMessageObservation = {
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
};

type TelegramEmbeddedReplyMessage = NonNullable<Message["reply_to_message"]>;

const DEFAULT_MAX_MESSAGES = 5000;
export const TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES = 3000;
export const TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE = "telegram.message-cache";
// Versioned writes preserve projection provenance. Shipped unversioned rows
// hydrate as markerless context only; they never imply transcript projection.
export const TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION = 1;
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

export type PersistedTelegramMessageCacheValue = {
  version: typeof TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION;
  sourceMessage: Message;
  botUserId?: number;
  promptContextProjection?: TelegramPromptContextProjection | TelegramPromptContextSource;
  threadBinding?: TelegramMessageThreadBinding;
  threadId?: string;
};

type TelegramMessageCachePersistentStore = {
  register(key: string, value: PersistedTelegramMessageCacheValue): Promise<void>;
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

export function resolveTelegramMessageCachePath(storePath: string): string {
  return `${storePath}.telegram-messages.json`;
}

export function resolveTelegramMessageCacheScope(storePath: string): string {
  return resolveTelegramMessageCachePath(storePath);
}

function resolveReplyMessage(msg: Message): Message | undefined {
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  return msg.reply_to_message ?? externalReply;
}

function resolveEmbeddedReplyMessage(msg: Message): Message | undefined {
  return msg.reply_to_message;
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
    threadBinding?: TelegramMessageThreadBinding;
  },
): TelegramCachedMessageNode {
  const media = resolveTelegramPrimaryMedia(msg);
  const fileId = media?.fileRef.file_id;
  const forwardedFrom = normalizeForwardedContext(msg);
  const replyMessage = resolveReplyMessage(msg);
  const body = resolveMessageBody(msg, params.promptContextProjectionMarker !== undefined);
  const threadId = parseTelegramMessageThreadId(params.threadId);
  const threadBinding = normalizeTelegramMessageThreadBinding(params.threadBinding, threadId);
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
    ...(threadBinding ? { threadBinding } : {}),
  };
}

function normalizeTelegramMessageThreadBinding(
  value: unknown,
  threadId: unknown,
): TelegramMessageThreadBinding | undefined {
  if (!isRecord(value) || value.kind !== "provider-observed-v1") {
    return undefined;
  }
  const normalizedThreadId = parseTelegramMessageThreadId(threadId);
  const observedThreadId = parseTelegramMessageThreadId(value.threadId);
  if (normalizedThreadId === undefined || observedThreadId !== normalizedThreadId) {
    return undefined;
  }
  return { kind: "provider-observed-v1", threadId: String(normalizedThreadId) };
}

function createTelegramMessageThreadBinding(
  threadId: unknown,
): TelegramMessageThreadBinding | undefined {
  const normalizedThreadId = parseTelegramMessageThreadId(threadId);
  return normalizedThreadId === undefined
    ? undefined
    : { kind: "provider-observed-v1", threadId: String(normalizedThreadId) };
}

export function hasProviderObservedTelegramThreadBinding(
  node: TelegramCachedMessageNode | null | undefined,
  threadId: unknown,
): boolean {
  return normalizeTelegramMessageThreadBinding(node?.threadBinding, threadId) !== undefined;
}

function normalizeMessageNodes(
  msg: Message,
  params: {
    threadId?: number;
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
    threadBinding?: TelegramMessageThreadBinding;
  },
): TelegramCachedMessageObservation[] {
  const observations: TelegramCachedMessageObservation[] = [];
  const visited = new Set<string>();
  const nodeThreadId = (node: TelegramCachedMessageNode) =>
    parseTelegramMessageThreadId(node.threadId);
  const visit = (
    message: Message,
    inheritedThreadId: number | undefined,
    mode: TelegramMessageObservationMode,
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker,
    threadBinding?: TelegramMessageThreadBinding,
  ) => {
    const node = normalizeMessageNode(message, {
      threadId:
        parseTelegramMessageThreadId(
          (message as { message_thread_id?: unknown }).message_thread_id,
        ) ?? inheritedThreadId,
      ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
      ...(threadBinding ? { threadBinding } : {}),
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
  );
  return observations;
}

function parseSafeMessageId(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseStrictPositiveInteger(value);
}

export function isTelegramMessageCacheSourceMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.message_id === "number" &&
    Number.isFinite(value.message_id) &&
    typeof value.date === "number" &&
    Number.isFinite(value.date)
  );
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
      ? normalizeTelegramMessageThreadBinding(value.threadBinding, threadId)
      : undefined;
  return normalizeMessageNodes(value.sourceMessage, {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
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
  const threadId = parseTelegramMessageThreadId(incoming.threadId ?? existing.threadId);
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
    normalizeTelegramMessageThreadBinding(incoming.threadBinding, threadId) ??
    normalizeTelegramMessageThreadBinding(existing.threadBinding, threadId);
  return normalizeMessageNode(sourceMessage, {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
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

export function resolveTelegramMessageCachePersistentScopeKey(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 24);
}

function resolveDefaultPersistentStore(): TelegramMessageCachePersistentStore | undefined {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    return runtime.state.openKeyedStore<PersistedTelegramMessageCacheValue>({
      namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
    });
  } catch (error) {
    logVerbose(`telegram: failed to open message cache plugin state: ${String(error)}`);
    return undefined;
  }
}

function resolveMessageCacheBucket(params: {
  bucketKey?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
}): TelegramMessageCacheBucket {
  const { bucketKey } = params;
  if (!bucketKey) {
    return {
      messages: new Map<string, TelegramCachedMessageNode>(),
      hydrated: true,
    };
  }
  const persistedMessageCacheBuckets = getPersistedMessageCacheBuckets();
  const existing = persistedMessageCacheBuckets.get(bucketKey);
  if (existing) {
    existing.persistentStore = params.persistentStore ?? existing.persistentStore;
    return existing;
  }
  const bucket = {
    messages: new Map<string, TelegramCachedMessageNode>(),
    hydrated: false,
    ...(params.persistentStore ? { persistentStore: params.persistentStore } : {}),
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
    try {
      storeEntries = (await bucket.persistentStore?.entries()) ?? [];
    } catch (error) {
      logVerbose(`telegram: failed to hydrate message cache from plugin state: ${String(error)}`);
    }
    const scopedStoreEntries = scopeKey
      ? storeEntries.filter(({ key }) => key.startsWith(`${scopeKey}:`))
      : storeEntries;

    for (const { key, value } of scopedStoreEntries) {
      for (const entry of parsePersistedCacheValue(key, value)) {
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
  bucketKey?: string;
}): TelegramMessageCache {
  const persistentStore = params?.persistentStore ?? resolveDefaultPersistentStore();
  const maxMessages =
    params?.maxMessages ??
    (persistentStore ? TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES : DEFAULT_MAX_MESSAGES);
  const scopeKey = persistentStore
    ? resolveTelegramMessageCachePersistentScopeKey(params?.scope ?? "default")
    : undefined;
  const bucketKey =
    params?.bucketKey ?? (persistentStore ? `${PERSISTENT_BUCKET_KEY}:${scopeKey}` : undefined);
  const bucket = resolveMessageCacheBucket({
    bucketKey,
    ...(persistentStore ? { persistentStore } : {}),
  });
  const { messages } = bucket;

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

  return {
    record: async ({
      accountId,
      botUserId,
      chatId,
      msg,
      promptContextProjection,
      providerObservedThreadId,
      threadId,
    }) => {
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const threadBinding = createTelegramMessageThreadBinding(providerObservedThreadId);
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
      });
      const currentObservation = observations.at(-1)!;
      let recordedEntry = currentObservation.node;
      for (const { node, mode } of observations) {
        const { messageId } = node;
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
  const maxDepth = params.maxDepth ?? 4;
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
