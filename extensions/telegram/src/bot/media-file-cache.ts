// Telegram plugin module implements media file cache behavior.
import fs from "node:fs";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMediaKind } from "./helpers.js";

export type CachedTelegramMediaFile = {
  path: string;
  kind: TelegramMediaKind;
  contentType?: string;
};

// Bounded LRU so a long-lived gateway cannot grow this without limit; entries
// are only local file references, never bytes.
const TELEGRAM_MEDIA_FILE_CACHE_MAX_ENTRIES = 500;

// Keyed by file_unique_id, which Telegram keeps stable for the same file even
// when file_id rotates, so a photo downloaded on its original inbound turn can
// be reused when a later reply quotes it.
const mediaFileCache = new Map<string, CachedTelegramMediaFile>();

export function getCachedTelegramMediaFile(fileUniqueId: string): CachedTelegramMediaFile | null {
  const entry = mediaFileCache.get(fileUniqueId);
  if (!entry) {
    return null;
  }
  // Gateway media maintenance prunes saved files by TTL; a cached path that no
  // longer exists must fall through to a fresh download instead of dispatching
  // a dangling path.
  if (!fs.existsSync(entry.path)) {
    mediaFileCache.delete(fileUniqueId);
    return null;
  }
  mediaFileCache.delete(fileUniqueId);
  mediaFileCache.set(fileUniqueId, entry);
  return entry;
}

export function cacheTelegramMediaFile(fileUniqueId: string, entry: CachedTelegramMediaFile): void {
  mediaFileCache.delete(fileUniqueId);
  mediaFileCache.set(fileUniqueId, entry);
  while (mediaFileCache.size > TELEGRAM_MEDIA_FILE_CACHE_MAX_ENTRIES) {
    const oldest = mediaFileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    mediaFileCache.delete(oldest);
  }
  logVerbose(`telegram: cached media file for ${fileUniqueId}`);
}

export function clearTelegramMediaFileCache(): void {
  mediaFileCache.clear();
}
