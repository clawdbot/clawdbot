// Telegram plugin module implements sent message cache behavior.
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";
import {
  resolveSentMessageScopeKey,
  sentMessageEntryKey,
  TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
  TTL_MS,
  type PersistedSentMessage,
  type SentMessageConfig,
} from "./sent-message-cache.legacy-state.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");

type SentMessageStore = Map<string, Map<string, number>>;
type SentMessagePersistentStore = PluginStateSyncKeyedStore<PersistedSentMessage>;

type SentMessageBucket = {
  scopeKey: string;
  store: SentMessageStore;
  nextCleanupAt: number;
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

function getSentMessageBucket(cfg?: SentMessageConfig): SentMessageBucket {
  const state = getSentMessageState();
  const scopeKey = resolveSentMessageScopeKey(cfg);
  const existing = state.bucketsByScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const bucket = {
    scopeKey,
    store: readPersistedSentMessages(scopeKey),
    nextCleanupAt: Date.now() + CLEANUP_INTERVAL_MS,
  };
  state.bucketsByScope.set(scopeKey, bucket);
  return bucket;
}

function getSentMessages(cfg?: SentMessageConfig): SentMessageStore {
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
  cfg?: SentMessageConfig,
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
  if (now >= bucket.nextCleanupAt) {
    cleanupExpiredSentMessages(store, now);
    bucket.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
  }
  try {
    persistSentMessage(bucket, scopeKey, idKey, now);
  } catch (error) {
    logVerbose(`telegram: failed to persist sent-message cache: ${String(error)}`);
  }
}

export function wasSentByBot(
  chatId: number | string,
  messageId: number,
  cfg?: SentMessageConfig,
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
