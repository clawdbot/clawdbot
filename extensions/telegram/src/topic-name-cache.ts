const MAX_ENTRIES = 2_048;

export type TopicEntry = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

const cache = new Map<string, TopicEntry>();

function cacheKey(chatId: number | string, threadId: number | string): string {
  return `${chatId}:${threadId}`;
}

function evictOldest(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    cache.delete(oldestKey);
  }
}

export function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
): void {
  const key = cacheKey(chatId, threadId);
  const existing = cache.get(key);
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    iconColor: patch.iconColor ?? existing?.iconColor,
    iconCustomEmojiId: patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId,
    closed: patch.closed ?? existing?.closed,
    updatedAt: Date.now(),
  };
  if (!merged.name) {
    return;
  }
  cache.delete(key);
  cache.set(key, merged);
  evictOldest();
}

export function getTopicName(
  chatId: number | string,
  threadId: number | string,
): string | undefined {
  const key = cacheKey(chatId, threadId);
  const entry = cache.get(key);
  if (entry) {
    const refreshedEntry: TopicEntry = {
      ...entry,
      updatedAt: Date.now(),
    };
    cache.delete(key);
    cache.set(key, refreshedEntry);
    return refreshedEntry.name;
  }
  return undefined;
}

export function getTopicEntry(
  chatId: number | string,
  threadId: number | string,
): TopicEntry | undefined {
  return cache.get(cacheKey(chatId, threadId));
}

export function clearTopicNameCache(): void {
  cache.clear();
}

export function topicNameCacheSize(): number {
  return cache.size;
}
