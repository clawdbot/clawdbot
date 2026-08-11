// Telegram plugin module implements sticker cache store behavior.
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";
import {
  normalizeCachedStickerForStore,
  TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
  TELEGRAM_STICKER_CACHE_NAMESPACE,
  type CachedSticker,
} from "./sticker-cache-store.legacy-state.js";

export type { CachedSticker };

type TelegramStickerCacheStore = PluginStateSyncKeyedStore<CachedSticker>;

function openStickerCacheStore(): TelegramStickerCacheStore {
  return getTelegramRuntime().state.openSyncKeyedStore<CachedSticker>({
    namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
    maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
  });
}

function normalizeStickerSearchText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function readStickerCacheStore<T>(
  operation: string,
  read: (store: TelegramStickerCacheStore) => T,
  fallback: T,
): T {
  try {
    return read(openStickerCacheStore());
  } catch (err) {
    logVerbose(`telegram sticker cache ${operation} failed: ${String(err)}`);
    return fallback;
  }
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  return readStickerCacheStore("lookup", (store) => store.lookup(fileUniqueId) ?? null, null);
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  readStickerCacheStore(
    "register",
    (store) => {
      store.register(sticker.fileUniqueId, normalizeCachedStickerForStore(sticker));
    },
    undefined,
  );
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const queryLower = normalizeStickerSearchText(query);
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const { value: sticker } of readStickerCacheStore(
    "entries",
    (store) => store.entries(),
    [],
  )) {
    let score = 0;
    const descLower = normalizeStickerSearchText(sticker.description);

    // Exact substring match in description
    if (descLower.includes(queryLower)) {
      score += 10;
    }

    // Word-level matching
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const descWords = descLower.split(/\s+/);
    for (const qWord of queryWords) {
      if (descWords.some((dWord) => dWord.includes(qWord))) {
        score += 5;
      }
    }

    // Emoji match
    if (sticker.emoji && query.includes(sticker.emoji)) {
      score += 8;
    }

    // Set name match
    if (normalizeStickerSearchText(sticker.setName).includes(queryLower)) {
      score += 3;
    }

    if (score > 0) {
      results.push({ sticker, score });
    }
  }

  return results
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.sticker);
}

/**
 * Get all cached stickers (for debugging/listing).
 */
export function getAllCachedStickers(): CachedSticker[] {
  return readStickerCacheStore(
    "entries",
    (store) => store.entries().map((entry) => entry.value),
    [],
  );
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { count: number; oldestAt?: string; newestAt?: string } {
  const stickers = getAllCachedStickers();
  if (stickers.length === 0) {
    return { count: 0 };
  }
  const sorted = [...stickers].toSorted(
    (a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime(),
  );
  return {
    count: stickers.length,
    oldestAt: sorted[0]?.cachedAt,
    newestAt: sorted[sorted.length - 1]?.cachedAt,
  };
}
