import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Message } from "grammy/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { appendRegularFileSync, replaceFileAtomicSync } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramPrimaryMedia } from "./bot/body-helpers.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  normalizeForwardedContext,
} from "./bot/helpers.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

export type TelegramReplyChainEntry = NonNullable<MsgContext["ReplyChain"]>[number];

export type TelegramCachedMessageNode = TelegramReplyChainEntry & {
  sourceMessage: Message;
};

export type TelegramConversationContextNode = {
  node: TelegramCachedMessageNode;
  isReplyTarget?: boolean;
};

export type TelegramMessageCache = {
  record: (params: {
    accountId: string;
    chatId: string | number;
    msg: Message;
    threadId?: number;
  }) => Promise<TelegramCachedMessageNode | null>;
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
};

type MessageWithExternalReply = Message & { external_reply?: Message };

type TelegramMessageCacheBucket = {
  messages: Map<string, TelegramCachedMessageNode>;
  persistedEntryCount: number;
  hydrated: boolean;
  hydratePromise?: Promise<void>;
  legacyPersistedPath?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
};

type PersistedMessageReadResult = {
  messages: Map<string, TelegramCachedMessageNode>;
  persistedEntryCount: number;
  needsRewrite: boolean;
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
const PERSISTENT_BUCKET_KEY = `plugin-state:${TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE}`;
const COMPACT_THRESHOLD_RATIO = 2;
const persistedMessageCacheBuckets = new Map<string, TelegramMessageCacheBucket>();

export type PersistedTelegramMessageCacheValue = {
  sourceMessage: Message;
  threadId?: string;
};

export type TelegramMessageCachePersistentStore = {
  register(key: string, value: PersistedTelegramMessageCacheValue): Promise<void>;
  entries(): Promise<Array<{ key: string; value: PersistedTelegramMessageCacheValue }>>;
};

export function resetTelegramMessageCacheBucketsForTest(): void {
  persistedMessageCacheBuckets.clear();
}

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

function resolveReplyMessage(msg: Message): Message | undefined {
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  return msg.reply_to_message ?? externalReply;
}

function resolveEmbeddedReplyMessage(msg: Message): Message | undefined {
  return msg.reply_to_message;
}

function resolveMessageBody(msg: Message): string | undefined {
  const text = getTelegramTextParts(msg).text.trim();
  if (text) {
    return text;
  }
  const location = extractTelegramLocation(msg);
  if (location) {
    return formatLocationText(location);
  }
  return resolveTelegramPrimaryMedia(msg)?.placeholder;
}

function resolveMediaType(placeholder?: string): string | undefined {
  return placeholder?.match(/^<media:([^>]+)>$/)?.[1];
}

function normalizeMessageNode(
  msg: Message,
  params: { threadId?: number },
): TelegramCachedMessageNode | null {
  if (typeof msg.message_id !== "number") {
    return null;
  }
  const media = resolveTelegramPrimaryMedia(msg);
  const fileId = media?.fileRef.file_id;
  const forwardedFrom = normalizeForwardedContext(msg);
  const replyMessage = resolveReplyMessage(msg);
  const body = resolveMessageBody(msg);
  const threadId = normalizeTelegramCacheThreadId(params.threadId);
  return {
    sourceMessage: msg,
    messageId: String(msg.message_id),
    sender: buildSenderName(msg) ?? "unknown sender",
    ...(msg.from?.id != null ? { senderId: String(msg.from.id) } : {}),
    ...(msg.from?.username ? { senderUsername: msg.from.username } : {}),
    ...(msg.date ? { timestamp: msg.date * 1000 } : {}),
    ...(body ? { body } : {}),
    ...(media ? { mediaType: resolveMediaType(media.placeholder) ?? media.placeholder } : {}),
    ...(fileId ? { mediaRef: `telegram:file/${fileId}` } : {}),
    ...(replyMessage?.message_id != null ? { replyToId: String(replyMessage.message_id) } : {}),
    ...(forwardedFrom?.from ? { forwardedFrom: forwardedFrom.from } : {}),
    ...(forwardedFrom?.fromId ? { forwardedFromId: forwardedFrom.fromId } : {}),
    ...(forwardedFrom?.fromUsername ? { forwardedFromUsername: forwardedFrom.fromUsername } : {}),
    ...(forwardedFrom?.date ? { forwardedDate: forwardedFrom.date * 1000 } : {}),
    ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
  };
}

function normalizeRequiredMessageNode(
  msg: Message,
  params: { threadId?: number },
): TelegramCachedMessageNode {
  const node = normalizeMessageNode(msg, params);
  if (!node) {
    throw new Error("Telegram message cache node missing message id");
  }
  return node;
}

function resolveMessageThreadId(msg: Message): number | undefined {
  const threadId = (msg as { message_thread_id?: unknown }).message_thread_id;
  return normalizeTelegramCacheThreadId(threadId);
}

function normalizeMessageNodes(
  msg: Message,
  params: { threadId?: number },
): TelegramCachedMessageObservation[] {
  const observations: TelegramCachedMessageObservation[] = [];
  const visited = new Set<string>();
  const nodeThreadId = (node: TelegramCachedMessageNode) => parseCachedThreadId(node.threadId);
  const visit = (
    message: Message,
    inheritedThreadId: number | undefined,
    mode: TelegramMessageObservationMode,
  ) => {
    const node = normalizeMessageNode(message, {
      threadId: resolveMessageThreadId(message) ?? inheritedThreadId,
    });
    if (!node?.messageId || visited.has(node.messageId)) {
      return;
    }
    visited.add(node.messageId);
    const replyMessage = resolveEmbeddedReplyMessage(message);
    if (replyMessage?.message_id != null) {
      visit(replyMessage, nodeThreadId(node) ?? inheritedThreadId, "partial");
    }
    observations.push({ node, mode });
  };
  visit(msg, params.threadId, "authoritative");
  return observations;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return isString(value) ? value : undefined;
}

function parseSafeMessageId(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseStrictPositiveInteger(value);
}

function parseCachedThreadId(value: unknown): number | undefined {
  return normalizeTelegramCacheThreadId(value);
}

function normalizeTelegramCacheThreadId(value: unknown): number | undefined {
  return parseTelegramMessageThreadId(value);
}

function isTelegramSourceMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.message_id === "number" &&
    Number.isFinite(value.message_id) &&
    typeof value.date === "number" &&
    Number.isFinite(value.date)
  );
}

function parsePersistedEntry(value: unknown): Array<{
  key: string;
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
}> {
  if (!isRecord(value) || !isString(value.key)) {
    return [];
  }
  const separatorIndex = value.key.lastIndexOf(":");
  if (
    separatorIndex === -1 ||
    !isRecord(value.node) ||
    !isTelegramSourceMessage(value.node.sourceMessage)
  ) {
    return [];
  }
  const keyPrefix = value.key.slice(0, separatorIndex + 1);
  const threadId = parseCachedThreadId(readOptionalString(value.node, "threadId"));
  const sourceMessageId = String(value.node.sourceMessage.message_id);
  const threadParams = threadId !== undefined ? { threadId } : {};
  return normalizeMessageNodes(value.node.sourceMessage, threadParams).map(({ node, mode }) => ({
    key: `${keyPrefix}${node.messageId}`,
    node,
    mode: node.messageId === sourceMessageId ? "authoritative" : mode,
  }));
}

function persistedValueToEntry(
  key: string,
  value: PersistedTelegramMessageCacheValue,
): {
  key: string;
  node: {
    sourceMessage: Message;
    threadId?: string;
  };
} {
  return {
    key,
    node: {
      sourceMessage: value.sourceMessage,
      ...(value.threadId ? { threadId: value.threadId } : {}),
    },
  };
}

function findJsonArrayEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!started) {
      if (char.trim() === "") {
        continue;
      }
      if (char !== "[") {
        return -1;
      }
      started = true;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

function readPersistedEntryValues(raw: string): { values: unknown[]; needsRewrite: boolean } {
  const values: unknown[] = [];
  let needsRewrite = false;
  const readLines = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        values.push(value);
      } catch {
        needsRewrite = true;
      }
    }
  };
  const trimmedStart = raw.trimStart();
  if (trimmedStart.startsWith("[")) {
    const startOffset = raw.length - trimmedStart.length;
    const arrayEnd = findJsonArrayEnd(raw.slice(startOffset));
    if (arrayEnd === -1) {
      needsRewrite = true;
      readLines(raw);
      return { values, needsRewrite };
    }
    const legacyValue: unknown = JSON.parse(raw.slice(startOffset, startOffset + arrayEnd));
    if (Array.isArray(legacyValue)) {
      values.push(...legacyValue);
    }
    needsRewrite = true;
    readLines(raw.slice(startOffset + arrayEnd));
    return { values, needsRewrite };
  }
  readLines(raw);
  return { values, needsRewrite };
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
  const threadId = parseCachedThreadId(incoming.threadId ?? existing.threadId);
  const sourceMessage =
    mode === "authoritative"
      ? mergeAuthoritativeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage)
      : mergeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage);
  return normalizeRequiredMessageNode(sourceMessage, threadId !== undefined ? { threadId } : {});
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

function readPersistedMessages(filePath: string, maxMessages: number): PersistedMessageReadResult {
  const messages = new Map<string, TelegramCachedMessageNode>();
  let persistedEntryCount = 0;
  let needsRewrite = false;
  if (!fs.existsSync(filePath)) {
    return { messages, persistedEntryCount, needsRewrite };
  }
  try {
    const persisted = readPersistedEntryValues(fs.readFileSync(filePath, "utf-8"));
    needsRewrite = persisted.needsRewrite;
    for (const value of persisted.values) {
      for (const entry of parsePersistedEntry(value)) {
        persistedEntryCount++;
        upsertCachedMessageNode({
          messages,
          key: entry.key,
          node: entry.node,
          mode: entry.mode,
        });
        trimMessages(messages, maxMessages);
      }
    }
  } catch (error) {
    logVerbose(`telegram: failed to read message cache: ${String(error)}`);
    needsRewrite = true;
  }
  return { messages, persistedEntryCount, needsRewrite };
}

function toPersistedCacheValue(
  node: TelegramCachedMessageNode,
): PersistedTelegramMessageCacheValue {
  return {
    sourceMessage: node.sourceMessage,
    ...(node.threadId ? { threadId: node.threadId } : {}),
  };
}

function serializePersistedEntry(key: string, node: TelegramCachedMessageNode): string {
  return `${JSON.stringify({
    key,
    node: toPersistedCacheValue(node),
  })}\n`;
}

function replaceLegacyPersistedMessages(params: {
  messages: Map<string, TelegramCachedMessageNode>;
  persistedPath?: string;
}): number {
  const { persistedPath, messages } = params;
  if (!persistedPath) {
    return messages.size;
  }
  if (messages.size === 0) {
    fs.rmSync(persistedPath, { force: true });
    return 0;
  }
  const serialized = Array.from(messages, ([key, node]) => serializePersistedEntry(key, node)).join(
    "",
  );
  replaceFileAtomicSync({
    filePath: persistedPath,
    content: serialized,
    tempPrefix: ".telegram-message-cache",
  });
  return messages.size;
}

function appendLegacyPersistedMessage(params: {
  key: string;
  node: TelegramCachedMessageNode;
  persistedPath?: string;
}): number {
  const { persistedPath } = params;
  if (!persistedPath) {
    return 0;
  }
  appendRegularFileSync({
    filePath: persistedPath,
    content: serializePersistedEntry(params.key, params.node),
  });
  return 1;
}

function resolvePersistentScopeKey(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 24);
}

export function resolveTelegramMessageCachePersistentScopeKey(scope: string): string {
  return resolvePersistentScopeKey(scope);
}

export function listTelegramLegacyMessageCacheEntries(params: {
  persistedPath: string;
  maxMessages?: number;
}): Array<{ key: string; value: PersistedTelegramMessageCacheValue }> {
  const persisted = readPersistedMessages(
    params.persistedPath,
    params.maxMessages ?? TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  );
  return Array.from(persisted.messages, ([key, node]) => ({
    key,
    value: toPersistedCacheValue(node),
  }));
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
  legacyPersistedPath?: string;
  maxMessages: number;
  persistentStore?: TelegramMessageCachePersistentStore;
}): TelegramMessageCacheBucket {
  const { bucketKey } = params;
  if (!bucketKey) {
    return {
      messages: new Map<string, TelegramCachedMessageNode>(),
      persistedEntryCount: 0,
      hydrated: true,
    };
  }
  const existing = persistedMessageCacheBuckets.get(bucketKey);
  if (existing) {
    existing.persistentStore = params.persistentStore ?? existing.persistentStore;
    existing.legacyPersistedPath = params.legacyPersistedPath ?? existing.legacyPersistedPath;
    return existing;
  }
  const bucket = {
    messages: new Map<string, TelegramCachedMessageNode>(),
    persistedEntryCount: 0,
    hydrated: false,
    ...(params.legacyPersistedPath ? { legacyPersistedPath: params.legacyPersistedPath } : {}),
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
    let storeEntries: Array<{ key: string; value: PersistedTelegramMessageCacheValue }> = [];
    try {
      storeEntries = (await bucket.persistentStore?.entries()) ?? [];
    } catch (error) {
      logVerbose(`telegram: failed to hydrate message cache from plugin state: ${String(error)}`);
    }
    const scopedStoreEntries = scopeKey
      ? storeEntries.filter(({ key }) => key.startsWith(`${scopeKey}:`))
      : storeEntries;

    const legacyPath = bucket.legacyPersistedPath;
    if (legacyPath) {
      const legacy = readPersistedMessages(legacyPath, maxMessages);
      if (legacy.messages.size > 0) {
        for (const [key, node] of legacy.messages) {
          const cacheKey = bucket.persistentStore && scopeKey ? `${scopeKey}:${key}` : key;
          upsertCachedMessageNode({
            messages: bucket.messages,
            key: cacheKey,
            node,
            mode: "authoritative",
          });
          trimMessages(bucket.messages, maxMessages);
        }
      }
      if (!bucket.persistentStore && legacy.needsRewrite) {
        try {
          bucket.persistedEntryCount = replaceLegacyPersistedMessages({
            messages: bucket.messages,
            persistedPath: legacyPath,
          });
        } catch (error) {
          logVerbose(`telegram: failed to compact message cache: ${String(error)}`);
        }
      }
    }
    for (const { key, value } of scopedStoreEntries) {
      for (const entry of parsePersistedEntry(persistedValueToEntry(key, value))) {
        bucket.persistedEntryCount++;
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
  maxMessages: number;
  node: TelegramCachedMessageNode;
}): Promise<void> {
  const { persistentStore } = params.bucket;
  if (!persistentStore) {
    try {
      params.bucket.persistedEntryCount += appendLegacyPersistedMessage({
        key: params.key,
        node: params.node,
        persistedPath: params.bucket.legacyPersistedPath,
      });
      if (params.bucket.persistedEntryCount > params.maxMessages * COMPACT_THRESHOLD_RATIO) {
        params.bucket.persistedEntryCount = replaceLegacyPersistedMessages({
          messages: params.bucket.messages,
          persistedPath: params.bucket.legacyPersistedPath,
        });
      }
    } catch (error) {
      logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
    }
    return;
  }
  try {
    await persistentStore.register(params.key, toPersistedCacheValue(params.node));
    params.bucket.persistedEntryCount++;
  } catch (error) {
    logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
  }
}

export function createTelegramMessageCache(params?: {
  maxMessages?: number;
  legacyPersistedPath?: string;
  persistedPath?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
  bucketKey?: string;
}): TelegramMessageCache {
  const persistentStore = params?.persistentStore ?? resolveDefaultPersistentStore();
  const maxMessages =
    params?.maxMessages ??
    (persistentStore ? TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES : DEFAULT_MAX_MESSAGES);
  const legacyPersistedPath = params?.legacyPersistedPath ?? params?.persistedPath;
  const scopeKey = persistentStore
    ? resolvePersistentScopeKey(legacyPersistedPath ?? params?.bucketKey ?? "default")
    : undefined;
  const bucketKey =
    params?.bucketKey ??
    (persistentStore
      ? `${PERSISTENT_BUCKET_KEY}:${scopeKey}`
      : legacyPersistedPath
        ? `legacy:${legacyPersistedPath}`
        : undefined);
  const bucket = resolveMessageCacheBucket({
    bucketKey,
    legacyPersistedPath,
    maxMessages,
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

  const listChatMessages = async (params: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
  }) => {
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
    const prefix = telegramMessageCacheKeyPrefix({ scopeKey, ...params });
    const normalizedThreadId = normalizeTelegramCacheThreadId(params.threadId);
    if (params.threadId != null && normalizedThreadId === undefined) {
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
    record: async ({ accountId, chatId, msg, threadId }) => {
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const observations = normalizeMessageNodes(msg, { threadId });
      const currentObservation = observations.at(-1);
      if (!currentObservation) {
        return null;
      }
      let recordedEntry: TelegramCachedMessageNode | null = null;
      for (const { node, mode } of observations) {
        const { messageId } = node;
        if (!messageId) {
          continue;
        }
        const key = telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId });
        const cachedNode = upsertCachedMessageNode({ messages, key, node, mode });
        if (messageId === currentObservation.node.messageId) {
          recordedEntry = cachedNode;
        }
        trimMessages(messages, maxMessages);
        await persistCachedNode({ bucket, key, maxMessages, node: cachedNode });
      }
      return recordedEntry ?? currentObservation.node;
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

function isSessionBoundaryCommandNode(node: TelegramCachedMessageNode): boolean {
  const body = node.body?.trim();
  return Boolean(
    body && SESSION_BOUNDARY_COMMAND_RE.test(body) && !SOFT_RESET_COMMAND_RE.test(body),
  );
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
  const { messageId } = params;
  const candidates = (
    await params.cache.recentBefore({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      limit: Number.MAX_SAFE_INTEGER,
    })
  ).filter(isSessionBoundaryCommandNode);
  const current = await params.cache.get({
    accountId: params.accountId,
    chatId: params.chatId,
    messageId,
  });
  if (current && isSessionBoundaryCommandNode(current)) {
    candidates.push(current);
  }
  return candidates.toSorted(compareCachedMessageNodes).at(-1);
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
  let current =
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
}): Promise<TelegramConversationContextNode[]> {
  const selected = new Map<string, TelegramConversationContextNode>();
  const replyTargetIds = new Set<string>();
  const sessionBoundary = await resolveSessionBoundaryNode(params);
  const sessionBoundaryTimestamp = normalizeSessionBoundaryTimestamp(params.minTimestampMs);
  const addNode = (node: TelegramCachedMessageNode, flags?: { replyTarget?: boolean }) => {
    if (!node.messageId || node.messageId === params.messageId) {
      return;
    }
    if (!isAfterSessionBoundary(node, sessionBoundary)) {
      return;
    }
    if (!isAtOrAfterSessionBoundaryTimestamp(node, sessionBoundaryTimestamp)) {
      return;
    }
    const existing = selected.get(node.messageId);
    const isReplyTarget = existing?.isReplyTarget === true || flags?.replyTarget === true;
    selected.set(node.messageId, {
      node: existing?.node ?? node,
      isReplyTarget: isReplyTarget ? true : undefined,
    });
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
    addNode(node);
    if (node.replyToId) {
      await addReplyTargetWindow(node.replyToId);
    }
  }

  for (const [index, node] of params.replyChainNodes.entries()) {
    addNode(node, { replyTarget: index === 0 });
    if (index === 0 && node.messageId) {
      await addReplyTargetWindow(node.messageId);
    }
    if (node.replyToId) {
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
