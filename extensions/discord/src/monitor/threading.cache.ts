import type { DiscordThreadStarter } from "./threading.types.js";

type DiscordThreadStarterCacheEntry = {
  value: DiscordThreadStarter;
  updatedAt: number;
};

const DISCORD_THREAD_STARTER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_THREAD_STARTER_CACHE_MAX = 500;

const DISCORD_THREAD_STARTER_CACHE = new Map<string, DiscordThreadStarterCacheEntry>();

export function __resetDiscordThreadStarterCacheForTest() {
  DISCORD_THREAD_STARTER_CACHE.clear();
}

export function getCachedThreadStarter(key: string, now: number): DiscordThreadStarter | undefined {
  const entry = DISCORD_THREAD_STARTER_CACHE.get(key);
  if (!entry) {
    return undefined;
  }
  if (now - entry.updatedAt > DISCORD_THREAD_STARTER_CACHE_TTL_MS) {
    DISCORD_THREAD_STARTER_CACHE.delete(key);
    return undefined;
  }
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, { ...entry, updatedAt: now });
  return entry.value;
}

export function setCachedThreadStarter(
  key: string,
  value: DiscordThreadStarter,
  now: number,
): void {
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, { value, updatedAt: now });
  while (DISCORD_THREAD_STARTER_CACHE.size > DISCORD_THREAD_STARTER_CACHE_MAX) {
    const iter = DISCORD_THREAD_STARTER_CACHE.keys().next();
    if (iter.done) {
      break;
    }
    DISCORD_THREAD_STARTER_CACHE.delete(iter.value);
  }
}
