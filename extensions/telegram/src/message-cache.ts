import fs from "node:fs";
import type { Message } from "@grammyjs/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { appendRegularFileSync, replaceFileAtomicSync } from "openclaw/plugin-sdk/security-runtime";
import { resolveTelegramPrimaryMedia } from "./bot/body-helpers.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  normalizeForwardedContext,
} from "./bot/helpers.js";

export type TelegramReplyChainEntry = NonNullable<MsgContext["ReplyChain"]>[number];

export type TelegramCachedMessageNode = TelegramReplyChainEntry & {
  sourceMessage: Message;
};

export type TelegramMessageCache = {
  record: (params: {
    accountId: string;
    chatId: string | number;
    msg: Message;
    threadId?: number;
  }) => TelegramCachedMessageNode | null;
  get: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
  }) => TelegramCachedMessageNode | null;
  recentBefore: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    limit: number;
  }) => TelegramCachedMessageNode[];
  around: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    before: number;
    after: number;
  }) => TelegramCachedMessageNode[];
};

type MessageWithExternalReply = Message & { external_reply?: Message };

type TelegramMessageCacheBucket = {
  messages: Map<string, TelegramCachedMessageNode>;
  persistedEntryCount: number;
};

const DEFAULT_MAX_MESSAGES = 5000;
const COMPACT_THRESHOLD_RATIO = 2;
const persistedMessageCacheBuckets = new Map<string, TelegramMessageCacheBucket>();

function telegramMessageCacheKey(params: {
  accountId: string;
  chatId: string | number;
  messageId: string;
}) {
  return `${params.accountId}:${params.chatId}:${params.messageId}`;
}

function telegramMessageCacheKeyPrefix(params: { accountId: string; chatId: string | number }) {
  return `${params.accountId}:${params.chatId}:`;
}

export function resolveTelegramMessageCachePath(storePath: string): string {
  return `${storePath}.telegram-messages.json`;
}

function resolveReplyMessage(msg: Message): Message | undefined {
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  return msg.reply_to_message ?? externalReply;
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
    ...(params.threadId != null ? { threadId: String(params.threadId) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return isString(value) ? value : undefined;
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

function parsePersistedNode(value: unknown): TelegramCachedMessageNode | null {
  if (!isRecord(value) || !isTelegramSourceMessage(value.sourceMessage)) {
    return null;
  }
  const threadId = Number(readOptionalString(value, "threadId"));
  return normalizeMessageNode(value.sourceMessage, Number.isFinite(threadId) ? { threadId } : {});
}

function parsePersistedEntry(value: unknown): {
  key: string;
  node: TelegramCachedMessageNode;
} | null {
  if (!isRecord(value) || !isString(value.key)) {
    return null;
  }
  const node = parsePersistedNode(value.node);
  return node ? { key: value.key, node } : null;
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

function readPersistedMessages(filePath: string, maxMessages: number) {
  const messages = new Map<string, TelegramCachedMessageNode>();
  let persistedEntryCount = 0;
  if (!fs.existsSync(filePath)) {
    return { messages, persistedEntryCount };
  }
  try {
    for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const entry = parsePersistedEntry(JSON.parse(line));
      if (!entry) {
        continue;
      }
      persistedEntryCount++;
      messages.delete(entry.key);
      messages.set(entry.key, entry.node);
      trimMessages(messages, maxMessages);
    }
  } catch (error) {
    logVerbose(`telegram: failed to read message cache: ${String(error)}`);
  }
  return { messages, persistedEntryCount };
}

function serializePersistedEntry(key: string, node: TelegramCachedMessageNode): string {
  return `${JSON.stringify({
    key,
    node: {
      sourceMessage: node.sourceMessage,
      ...(node.threadId ? { threadId: node.threadId } : {}),
    },
  })}\n`;
}

function replacePersistedMessages(params: {
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

function appendPersistedMessage(params: {
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

function resolveMessageCacheBucket(params: {
  persistedPath?: string;
  maxMessages: number;
}): TelegramMessageCacheBucket {
  const { persistedPath, maxMessages } = params;
  if (!persistedPath) {
    return { messages: new Map<string, TelegramCachedMessageNode>(), persistedEntryCount: 0 };
  }
  const existing = persistedMessageCacheBuckets.get(persistedPath);
  if (existing) {
    if (!fs.existsSync(persistedPath)) {
      existing.messages.clear();
      existing.persistedEntryCount = 0;
    }
    return existing;
  }
  const persisted = readPersistedMessages(persistedPath, maxMessages);
  const bucket = {
    messages: persisted.messages,
    persistedEntryCount: persisted.persistedEntryCount,
  };
  persistedMessageCacheBuckets.set(persistedPath, bucket);
  return bucket;
}

export function createTelegramMessageCache(params?: {
  maxMessages?: number;
  persistedPath?: string;
}): TelegramMessageCache {
  const maxMessages = params?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const bucket = resolveMessageCacheBucket({
    persistedPath: params?.persistedPath,
    maxMessages,
  });
  const { messages } = bucket;

  const get: TelegramMessageCache["get"] = ({ accountId, chatId, messageId }) => {
    if (!messageId) {
      return null;
    }
    const key = telegramMessageCacheKey({ accountId, chatId, messageId });
    const entry = messages.get(key);
    if (!entry) {
      return null;
    }
    messages.delete(key);
    messages.set(key, entry);
    return entry;
  };

  const listChatMessages = (params: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
  }) => {
    const prefix = telegramMessageCacheKeyPrefix(params);
    const threadId = params.threadId != null ? String(params.threadId) : undefined;
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
    record: ({ accountId, chatId, msg, threadId }) => {
      const entry = normalizeMessageNode(msg, { threadId });
      if (!entry?.messageId) {
        return null;
      }
      const key = telegramMessageCacheKey({ accountId, chatId, messageId: entry.messageId });
      messages.delete(key);
      messages.set(key, entry);
      trimMessages(messages, maxMessages);
      try {
        bucket.persistedEntryCount += appendPersistedMessage({
          key,
          node: entry,
          persistedPath: params?.persistedPath,
        });
        if (bucket.persistedEntryCount > maxMessages * COMPACT_THRESHOLD_RATIO) {
          bucket.persistedEntryCount = replacePersistedMessages({
            messages,
            persistedPath: params?.persistedPath,
          });
        }
      } catch (error) {
        logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
      }
      return entry;
    },
    get,
    recentBefore: ({ accountId, chatId, messageId, threadId, limit }) => {
      if (!messageId || limit <= 0) {
        return [];
      }
      const targetId = Number(messageId);
      if (!Number.isFinite(targetId)) {
        return [];
      }
      return listChatMessages({ accountId, chatId, threadId })
        .filter((entry) => {
          const entryId = Number(entry.messageId);
          return Number.isFinite(entryId) && entryId < targetId;
        })
        .slice(-limit);
    },
    around: ({ accountId, chatId, messageId, threadId, before, after }) => {
      if (!messageId) {
        return [];
      }
      const entries = listChatMessages({ accountId, chatId, threadId });
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
  const leftId = Number(left.messageId);
  const rightId = Number(right.messageId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) {
    return leftId - rightId;
  }
  return (left.messageId ?? "").localeCompare(right.messageId ?? "");
}

export function buildTelegramReplyChain(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  msg: Message;
  maxDepth?: number;
}): TelegramCachedMessageNode[] {
  const replyMessage = resolveReplyMessage(params.msg);
  if (!replyMessage?.message_id) {
    return [];
  }
  const maxDepth = params.maxDepth ?? 4;
  const visited = new Set<string>();
  const chain: TelegramCachedMessageNode[] = [];
  let current =
    params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: String(replyMessage.message_id),
    }) ?? normalizeMessageNode(replyMessage, {});

  while (current?.messageId && chain.length < maxDepth && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    chain.push(current);
    current = params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: current.replyToId,
    });
  }

  return chain;
}
