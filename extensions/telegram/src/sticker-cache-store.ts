import path from "node:path";
import { loadJsonFile, saveJsonFile } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const CACHE_VERSION = 1;

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

interface StickerCache {
  version: number;
  stickers: Record<string, CachedSticker>;
}

function getCacheFile(): string {
  return path.join(resolveStateDir(), "telegram", "sticker-cache.json");
}

function loadCache(): StickerCache {
  const data = loadJsonFile(getCacheFile());
  if (!data || typeof data !== "object") {
    return { version: CACHE_VERSION, stickers: {} };
  }
  const cache = data as StickerCache;
  if (cache.version !== CACHE_VERSION) {
    // Future: handle migration if needed
    return { version: CACHE_VERSION, stickers: {} };
  }
  return cache;
}

function saveCache(cache: StickerCache): void {
  saveJsonFile(getCacheFile(), cache);
}

function normalizeStickerSearchText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  const cache = loadCache();
  return cache.stickers[fileUniqueId] ?? null;
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  const cache = loadCache();
  cache.stickers[sticker.fileUniqueId] = sticker;
  saveCache(cache);
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const cache = loadCache();
  const queryLower = normalizeStickerSearchText(query);
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const sticker of Object.values(cache.stickers)) {
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
  const cache = loadCache();
  return Object.values(cache.stickers);
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { count: number; oldestAt?: string; newestAt?: string } {
  const cache = loadCache();
  const stickers = Object.values(cache.stickers);
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
