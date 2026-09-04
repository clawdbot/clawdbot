// Telegram sticker cache row shape, keys, and legacy sidecar reader.
//
// Split from `sticker-cache-store.ts`, which also value-loads the plugin runtime
// slot and the logger graph. Doctor enumeration cold-loads this module to plan the
// legacy-state import, so it stays a leaf.
import { loadJsonFile } from "openclaw/plugin-sdk/json-store";

const CACHE_VERSION = 1;
export const TELEGRAM_STICKER_CACHE_NAMESPACE = "telegram.sticker-cache";
export const TELEGRAM_STICKER_CACHE_MAX_ENTRIES = 10_000;

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

export function normalizeCachedStickerForStore(sticker: CachedSticker): CachedSticker {
  return {
    fileId: sticker.fileId,
    fileUniqueId: sticker.fileUniqueId,
    description: sticker.description,
    cachedAt: sticker.cachedAt,
    ...(sticker.emoji !== undefined ? { emoji: sticker.emoji } : {}),
    ...(sticker.setName !== undefined ? { setName: sticker.setName } : {}),
    ...(sticker.receivedFrom !== undefined ? { receivedFrom: sticker.receivedFrom } : {}),
  };
}

function loadCacheFile(filePath: string): StickerCache {
  const data = loadJsonFile(filePath);
  if (!data || typeof data !== "object") {
    return { version: CACHE_VERSION, stickers: {} };
  }
  const cache = data as StickerCache;
  if (cache.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, stickers: {} };
  }
  return cache;
}

export function listTelegramLegacyStickerCacheEntries(params: {
  persistedPath: string;
}): Array<{ key: string; value: CachedSticker }> {
  const cache = loadCacheFile(params.persistedPath);
  return Object.entries(cache.stickers).map(([key, value]) => ({
    key,
    value: normalizeCachedStickerForStore(value),
  }));
}
