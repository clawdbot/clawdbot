import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

const MAX_ENTRIES = 2_048;
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");
const DEFAULT_TOPIC_NAME_CACHE_KEY = "__default__";

export type TopicEntry = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

type TopicNameStore = Map<string, TopicEntry>;

type TopicNameStoreState = {
  lastUpdatedAt: number;
  store: TopicNameStore;
};

type TopicNameCacheState = {
  stores: Map<string, TopicNameStoreState>;
};

function createTopicNameStore(): TopicNameStore {
  return new Map<string, TopicEntry>();
}

function createTopicNameStoreState(): TopicNameStoreState {
  return {
    lastUpdatedAt: 0,
    store: createTopicNameStore(),
  };
}

function getTopicNameCacheState(): TopicNameCacheState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TOPIC_NAME_CACHE_STATE_KEY] as TopicNameCacheState | undefined;
  if (existing) {
    return existing;
  }
  const state: TopicNameCacheState = { stores: new Map() };
  globalStore[TOPIC_NAME_CACHE_STATE_KEY] = state;
  return state;
}

function cacheKey(chatId: number | string, threadId: number | string): string {
  return `${chatId}:${threadId}`;
}

export function resolveTopicNameCachePath(storePath: string): string {
  return `${storePath}.telegram-topic-names.json`;
}

function evictOldest(store: TopicNameStore): void {
  if (store.size <= MAX_ENTRIES) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestTime = Infinity;
  for (const [key, entry] of store) {
    if (entry.updatedAt < oldestTime) {
      oldestTime = entry.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    store.delete(oldestKey);
  }
}

function isTopicEntry(value: unknown): value is TopicEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<TopicEntry>;
  return (
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

function readPersistedTopicNames(persistedPath: string): TopicNameStore {
  if (!fs.existsSync(persistedPath)) {
    return createTopicNameStore();
  }
  try {
    const raw = fs.readFileSync(persistedPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .filter((entry): entry is [string, TopicEntry] => isTopicEntry(entry[1]))
      .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ENTRIES);
    return new Map(entries);
  } catch (error) {
    logVerbose(`telegram: failed to read topic-name cache: ${String(error)}`);
    return createTopicNameStore();
  }
}

function getTopicStoreState(persistedPath?: string): TopicNameStoreState {
  const state = getTopicNameCacheState();
  const stateKey = persistedPath ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
  const existing = state.stores.get(stateKey);
  if (existing) {
    return existing;
  }
  const next = persistedPath
    ? {
        lastUpdatedAt: 0,
        store: readPersistedTopicNames(persistedPath),
      }
    : createTopicNameStoreState();
  next.lastUpdatedAt = Math.max(0, ...Array.from(next.store.values(), (entry) => entry.updatedAt));
  state.stores.set(stateKey, next);
  return next;
}

function getTopicStore(persistedPath?: string): TopicNameStore {
  return getTopicStoreState(persistedPath).store;
}

function nextUpdatedAt(persistedPath?: string): number {
  const state = getTopicStoreState(persistedPath);
  const now = Date.now();
  state.lastUpdatedAt = now > state.lastUpdatedAt ? now : state.lastUpdatedAt + 1;
  return state.lastUpdatedAt;
}

function removeTopicStore(persistedPath?: string): void {
  const state = getTopicNameCacheState();
  const stateKey = persistedPath ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
  if (persistedPath) {
    fs.rmSync(persistedPath, { force: true });
  }
  state.stores.delete(stateKey);
}

function persistTopicStore(persistedPath: string, store: TopicNameStore): void {
  if (store.size === 0) {
    fs.rmSync(persistedPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
  const tempPath = `${persistedPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(Object.fromEntries(store)), "utf-8");
  fs.renameSync(tempPath, persistedPath);
}

export function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
  persistedPath?: string,
): void {
  const cache = getTopicStore(persistedPath);
  const key = cacheKey(chatId, threadId);
  const existing = cache.get(key);
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    iconColor: patch.iconColor ?? existing?.iconColor,
    iconCustomEmojiId: patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId,
    closed: patch.closed ?? existing?.closed,
    updatedAt: nextUpdatedAt(persistedPath),
  };
  if (!merged.name) {
    return;
  }
  cache.set(key, merged);
  evictOldest(cache);
  if (persistedPath) {
    try {
      persistTopicStore(persistedPath, cache);
    } catch (error) {
      logVerbose(`telegram: failed to persist topic-name cache: ${String(error)}`);
    }
  }
}

export function getTopicName(
  chatId: number | string,
  threadId: number | string,
  persistedPath?: string,
): string | undefined {
  const entry = getTopicStore(persistedPath).get(cacheKey(chatId, threadId));
  if (entry) {
    entry.updatedAt = nextUpdatedAt(persistedPath);
  }
  return entry?.name;
}

export function getTopicEntry(
  chatId: number | string,
  threadId: number | string,
  persistedPath?: string,
): TopicEntry | undefined {
  return getTopicStore(persistedPath).get(cacheKey(chatId, threadId));
}

export function clearTopicNameCache(): void {
  const state = getTopicNameCacheState();
  for (const stateKey of state.stores.keys()) {
    removeTopicStore(stateKey === DEFAULT_TOPIC_NAME_CACHE_KEY ? undefined : stateKey);
  }
}

export function topicNameCacheSize(): number {
  return getTopicStore().size;
}

export function resetTopicNameCacheForTest(): void {
  getTopicNameCacheState().stores.clear();
}
