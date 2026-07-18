// Telegram plugin module implements sent message cache behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { getTelegramRuntime } from "./runtime.js";

const TTL_MS = 24 * 60 * 60 * 1000;
export const TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE = "telegram.sent-messages";
export const TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES = 10_000;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");

type PersistedSentMessage = {
  scopeKey: string;
  chatId: string;
  messageId: string;
  timestamp: number;
};

type SentMessageStore = Map<string, Map<string, number>>;
type SentMessagePersistentStore = PluginStateSyncKeyedStore<PersistedSentMessage>;

type SentMessageBucket = {
  scopeKey: string;
  store: SentMessageStore;
};

type SentMessageState = {
  bucketsByScope: Map<string, SentMessageBucket>;
};

function getSentMessageState(): SentMessageState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] as SentMessageState | undefined;
  if (existing) {
    return existing;
  }
  const state: SentMessageState = {
    bucketsByScope: new Map(),
  };
  globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] = state;
  return state;
}

function createSentMessageStore(): SentMessageStore {
  return new Map<string, Map<string, number>>();
}

function resolveSentMessageStorePath(cfg?: Pick<OpenClawConfig, "session">): string {
  return `${resolveStorePath(cfg?.session?.store)}.telegram-sent-messages.json`;
}

function resolveSentMessageScopeKey(cfg?: Pick<OpenClawConfig, "session">): string {
  const storePath = resolveStorePath(cfg?.session?.store);
  return createHash("sha256").update(storePath, "utf8").digest("hex").slice(0, 24);
}

function sentMessageEntryKey(scopeKey: string, chatId: string, messageId: string): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${chatId}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function openSentMessageStore(): SentMessagePersistentStore {
  return getTelegramRuntime().state.openSyncKeyedStore<PersistedSentMessage>({
    namespace: TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
    maxEntries: TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  });
}

function cleanupExpired(
  store: SentMessageStore,
  scopeKey: string,
  entry: Map<string, number>,
  now: number,
): void {
  for (const [id, timestamp] of entry) {
    if (now - timestamp >= TTL_MS) {
      entry.delete(id);
    }
  }
  if (entry.size === 0) {
    store.delete(scopeKey);
  }
}

function cleanupExpiredSentMessages(store: SentMessageStore, now: number): void {
  for (const [scopeKey, entry] of store) {
    cleanupExpired(store, scopeKey, entry, now);
  }
}

function readLegacySentMessages(filePath: string): SentMessageStore {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, number>>;
    const now = Date.now();
    const store = createSentMessageStore();
    for (const [chatId, entry] of Object.entries(parsed)) {
      const messages = new Map<string, number>();
      for (const [messageId, timestamp] of Object.entries(entry)) {
        if (
          typeof timestamp === "number" &&
          Number.isFinite(timestamp) &&
          now - timestamp < TTL_MS
        ) {
          messages.set(messageId, timestamp);
        }
      }
      if (messages.size > 0) {
        store.set(chatId, messages);
      }
    }
    return store;
  } catch (error) {
    logVerbose(`telegram: failed to read sent-message cache: ${String(error)}`);
    return createSentMessageStore();
  }
}

function readPersistedSentMessages(scopeKey: string): SentMessageStore {
  const now = Date.now();
  const store = createSentMessageStore();
  try {
    for (const entry of openSentMessageStore().entries()) {
      if (entry.value.scopeKey !== scopeKey || now - entry.value.timestamp > TTL_MS) {
        continue;
      }
      let messages = store.get(entry.value.chatId);
      if (!messages) {
        messages = new Map<string, number>();
        store.set(entry.value.chatId, messages);
      }
      messages.set(entry.value.messageId, entry.value.timestamp);
    }
  } catch (error) {
    logVerbose(`telegram: failed to read sent-message cache: ${String(error)}`);
  }
  return store;
}

function getSentMessageBucket(cfg?: Pick<OpenClawConfig, "session">): SentMessageBucket {
  const state = getSentMessageState();
  const scopeKey = resolveSentMessageScopeKey(cfg);
  const existing = state.bucketsByScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const bucket = {
    scopeKey,
    store: readPersistedSentMessages(scopeKey),
  };
  state.bucketsByScope.set(scopeKey, bucket);
  return bucket;
}

function getSentMessages(cfg?: Pick<OpenClawConfig, "session">): SentMessageStore {
  return getSentMessageBucket(cfg).store;
}

function persistSentMessage(
  bucket: SentMessageBucket,
  chatId: string,
  messageId: string,
  timestamp: number,
): void {
  openSentMessageStore().register(
    sentMessageEntryKey(bucket.scopeKey, chatId, messageId),
    { scopeKey: bucket.scopeKey, chatId, messageId, timestamp },
    { ttlMs: TTL_MS },
  );
}

export function recordSentMessage(
  chatId: number | string,
  messageId: number,
  cfg?: Pick<OpenClawConfig, "session">,
): void {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const now = Date.now();
  const bucket = getSentMessageBucket(cfg);
  const { store } = bucket;
  let entry = store.get(scopeKey);
  if (!entry) {
    entry = new Map<string, number>();
    store.set(scopeKey, entry);
  }
  entry.set(idKey, now);
  cleanupExpiredSentMessages(store, now);
  try {
    persistSentMessage(bucket, scopeKey, idKey, now);
  } catch (error) {
    logVerbose(`telegram: failed to persist sent-message cache: ${String(error)}`);
  }
}

export function wasSentByBot(
  chatId: number | string,
  messageId: number,
  cfg?: Pick<OpenClawConfig, "session">,
): boolean {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const store = getSentMessages(cfg);
  const entry = store.get(scopeKey);
  if (!entry) {
    return false;
  }
  cleanupExpired(store, scopeKey, entry, Date.now());
  return entry.has(idKey);
}

export function listTelegramLegacySentMessageCacheEntries(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  persistedPath?: string;
}): Array<{ key: string; value: PersistedSentMessage; ttlMs?: number; timestamp?: number }> {
  const scopeKey = resolveSentMessageScopeKey(params.cfg);
  const filePath = params.persistedPath ?? resolveSentMessageStorePath(params.cfg);
  const legacy = fs.existsSync(filePath)
    ? readLegacySentMessages(filePath)
    : createSentMessageStore();
  return [...legacy.entries()].flatMap(([chatId, messages]) =>
    [...messages.entries()].flatMap(([messageId, timestamp]) => {
      const ttlMs = TTL_MS - Math.max(0, Date.now() - timestamp);
      return ttlMs > 0
        ? [
            {
              key: sentMessageEntryKey(scopeKey, chatId, messageId),
              value: { scopeKey, chatId, messageId, timestamp },
              ttlMs,
              timestamp,
            },
          ]
        : [];
    }),
  );
}
