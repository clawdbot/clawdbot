import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

const TTL_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");

type SentMessageStore = Map<string, Map<string, number>>;

type SentMessageBucket = {
  persistedPath: string;
  store: SentMessageStore;
};

type SentMessageState = {
  bucketsByPath: Map<string, SentMessageBucket>;
};

function getSentMessageState(): SentMessageState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] as SentMessageState | undefined;
  if (existing) {
    return existing;
  }
  const state: SentMessageState = {
    bucketsByPath: new Map(),
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

function cleanupExpired(
  store: SentMessageStore,
  scopeKey: string,
  entry: Map<string, number>,
  now: number,
): void {
  for (const [id, timestamp] of entry) {
    if (now - timestamp > TTL_MS) {
      entry.delete(id);
    }
  }
  if (entry.size === 0) {
    store.delete(scopeKey);
  }
}

function readPersistedSentMessages(filePath: string): SentMessageStore {
  if (!fs.existsSync(filePath)) {
    return createSentMessageStore();
  }
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
          now - timestamp <= TTL_MS
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

function getSentMessageBucket(cfg?: Pick<OpenClawConfig, "session">): SentMessageBucket {
  const state = getSentMessageState();
  const persistedPath = resolveSentMessageStorePath(cfg);
  const existing = state.bucketsByPath.get(persistedPath);
  if (existing) {
    return existing;
  }
  const bucket = {
    persistedPath,
    store: readPersistedSentMessages(persistedPath),
  };
  state.bucketsByPath.set(persistedPath, bucket);
  return bucket;
}

function getSentMessages(cfg?: Pick<OpenClawConfig, "session">): SentMessageStore {
  return getSentMessageBucket(cfg).store;
}

function persistSentMessages(bucket: SentMessageBucket): void {
  const { store, persistedPath } = bucket;
  const now = Date.now();
  const serialized: Record<string, Record<string, number>> = {};
  for (const [chatId, entry] of store) {
    cleanupExpired(store, chatId, entry, now);
    if (entry.size > 0) {
      serialized[chatId] = Object.fromEntries(entry);
    }
  }
  if (Object.keys(serialized).length === 0) {
    fs.rmSync(persistedPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
  const tempPath = `${persistedPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(serialized), "utf-8");
  fs.renameSync(tempPath, persistedPath);
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
  if (entry.size > 100) {
    cleanupExpired(store, scopeKey, entry, now);
  }
  try {
    persistSentMessages(bucket);
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

export function clearSentMessageCache(): void {
  const state = getSentMessageState();
  for (const bucket of state.bucketsByPath.values()) {
    bucket.store.clear();
    fs.rmSync(bucket.persistedPath, { force: true });
  }
  state.bucketsByPath.clear();
}

export function resetSentMessageCacheForTest(): void {
  getSentMessageState().bucketsByPath.clear();
}
