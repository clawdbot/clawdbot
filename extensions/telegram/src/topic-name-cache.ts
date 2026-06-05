// Telegram plugin module implements topic name cache behavior.
import { createHash } from "node:crypto";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import { getTelegramRuntime } from "./runtime.js";

export const TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES = 2_048;
const STORE_NAMESPACE_PREFIX = "telegram.topic-name-cache";
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");
const DEFAULT_TOPIC_NAME_CACHE_SCOPE = "default";

type TopicEntry = {
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
  hydrated: boolean;
  hydratePromise?: Promise<void>;
  persistentStore: TopicNamePersistentStore;
};

type TopicNameCacheState = {
  stores: Map<string, TopicNameStoreState>;
};

type TopicNamePersistentStore = {
  register(key: string, value: TopicEntry): Promise<void>;
  entries(): Promise<Array<{ key: string; value: TopicEntry }>>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
};

let topicNameStoreFactoryForTest: ((namespace: string) => TopicNamePersistentStore) | undefined;

function createTopicNameStore(): TopicNameStore {
  return new Map<string, TopicEntry>();
}

function createTopicNameStoreState(namespace: string): TopicNameStoreState {
  return {
    lastUpdatedAt: 0,
    store: createTopicNameStore(),
    hydrated: false,
    persistentStore: openTopicNamePersistentStore(namespace),
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

function namespaceForScope(scope: string): string {
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return `${STORE_NAMESPACE_PREFIX}.${hash}`;
}

export function resolveTopicNameCachePath(storePath: string): string {
  return `${storePath}.telegram-topic-names.json`;
}

export function resolveTopicNameCacheScope(storePath: string): string {
  return storePath;
}

export function resolveTopicNameCacheNamespace(scope: string): string {
  return namespaceForScope(scope);
}

function openTopicNamePersistentStore(namespace: string): TopicNamePersistentStore {
  return (
    topicNameStoreFactoryForTest?.(namespace) ??
    getTelegramRuntime().state.openKeyedStore<TopicEntry>({
      namespace,
      maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
    })
  );
}

function evictOldest(store: TopicNameStore): string | undefined {
  if (store.size <= TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES) {
    return undefined;
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
  return oldestKey;
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

function getTopicStoreState(scope?: string): TopicNameStoreState {
  const state = getTopicNameCacheState();
  const stateKey = scope ?? DEFAULT_TOPIC_NAME_CACHE_SCOPE;
  const existing = state.stores.get(stateKey);
  if (existing) {
    return existing;
  }
  const next = createTopicNameStoreState(namespaceForScope(stateKey));
  state.stores.set(stateKey, next);
  return next;
}

async function hydrateTopicStoreState(state: TopicNameStoreState): Promise<void> {
  if (state.hydrated) {
    return;
  }
  if (state.hydratePromise) {
    await state.hydratePromise;
    return;
  }
  state.hydratePromise = (async () => {
    const entries = await state.persistentStore.entries();
    for (const { key, value } of entries) {
      if (isTopicEntry(value)) {
        state.store.set(key, value);
      }
    }
    state.lastUpdatedAt = Math.max(
      0,
      ...Array.from(state.store.values(), (entry) => entry.updatedAt),
    );
    state.hydrated = true;
  })().finally(() => {
    state.hydratePromise = undefined;
  });
  await state.hydratePromise;
}

async function getTopicStore(scope?: string): Promise<TopicNameStore> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  return state.store;
}

function nextUpdatedAt(scope?: string): number {
  const state = getTopicStoreState(scope);
  const now = Date.now();
  state.lastUpdatedAt = now > state.lastUpdatedAt ? now : state.lastUpdatedAt + 1;
  return state.lastUpdatedAt;
}

export async function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
  scope?: string,
): Promise<void> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  const key = cacheKey(chatId, threadId);
  const existing = state.store.get(key);
  const iconColor = patch.iconColor ?? existing?.iconColor;
  const iconCustomEmojiId = patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId;
  const closed = patch.closed ?? existing?.closed;
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    updatedAt: nextUpdatedAt(scope),
    ...(iconColor !== undefined ? { iconColor } : {}),
    ...(iconCustomEmojiId !== undefined ? { iconCustomEmojiId } : {}),
    ...(closed !== undefined ? { closed } : {}),
  };
  if (!merged.name) {
    return;
  }
  state.store.set(key, merged);
  await state.persistentStore.register(key, merged);
  const evictedKey = evictOldest(state.store);
  if (evictedKey) {
    await state.persistentStore.delete(evictedKey);
  }
}

export async function getTopicName(
  chatId: number | string,
  threadId: number | string,
  scope?: string,
): Promise<string | undefined> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  const key = cacheKey(chatId, threadId);
  const entry = state.store.get(key);
  if (entry) {
    entry.updatedAt = nextUpdatedAt(scope);
    await state.persistentStore.register(key, entry);
  }
  return entry?.name;
}

export async function getTopicEntry(
  chatId: number | string,
  threadId: number | string,
  scope?: string,
): Promise<TopicEntry | undefined> {
  return (await getTopicStore(scope)).get(cacheKey(chatId, threadId));
}

export async function listTelegramLegacyTopicNameCacheEntries(params: {
  persistedPath: string;
  maxEntries?: number;
}): Promise<Array<{ key: string; value: TopicEntry }>> {
  const { value } = await readJsonFileWithFallback<Record<string, unknown>>(
    params.persistedPath,
    {},
  );
  return Object.entries(value)
    .filter((entry): entry is [string, TopicEntry] => isTopicEntry(entry[1]))
    .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, params.maxEntries ?? TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES)
    .map(([key, entry]) => ({ key, value: entry }));
}

export async function clearTopicNameCache(): Promise<void> {
  const state = getTopicNameCacheState();
  await Promise.all(
    [...state.stores.values()].map((storeState) => storeState.persistentStore.clear()),
  );
  state.stores.clear();
}

export function topicNameCacheSize(scope?: string): number {
  return getTopicStoreState(scope).store.size;
}

export function resetTopicNameCacheForTest(): void {
  getTopicNameCacheState().stores.clear();
}

export function setTelegramTopicNameStoreFactoryForTest(
  factory: ((namespace: string) => TopicNamePersistentStore) | undefined,
): void {
  topicNameStoreFactoryForTest = factory;
}
