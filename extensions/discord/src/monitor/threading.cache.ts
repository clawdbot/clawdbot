// Discord plugin module implements threading.cache behavior.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { DiscordThreadStarter } from "./threading.types.js";

type DiscordThreadStarterCacheEntry = {
  value: DiscordThreadStarterCacheValue;
  updatedAt: number;
};

type DiscordThreadStarterCacheValue =
  | { kind: "hit"; starter: DiscordThreadStarter }
  | { kind: "miss" };

const DISCORD_THREAD_STARTER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_THREAD_STARTER_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DISCORD_THREAD_STARTER_CACHE_MAX = 500;

const DISCORD_THREAD_STARTER_CACHE = new Map<string, DiscordThreadStarterCacheEntry>();

export function getCachedThreadStarter(
  key: string,
  now: number,
): DiscordThreadStarterCacheValue | undefined {
  const entry = DISCORD_THREAD_STARTER_CACHE.get(key);
  if (!entry) {
    return undefined;
  }
  const ttlMs =
    entry.value.kind === "miss"
      ? DISCORD_THREAD_STARTER_NEGATIVE_CACHE_TTL_MS
      : DISCORD_THREAD_STARTER_CACHE_TTL_MS;
  if (now < entry.updatedAt || now - entry.updatedAt >= ttlMs) {
    DISCORD_THREAD_STARTER_CACHE.delete(key);
    return undefined;
  }
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, entry);
  return entry.value;
}

export function setCachedThreadStarter(
  key: string,
  value: DiscordThreadStarterCacheValue,
  now: number,
): void {
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, { value, updatedAt: now });
  pruneMapToMaxSize(DISCORD_THREAD_STARTER_CACHE, DISCORD_THREAD_STARTER_CACHE_MAX);
}
