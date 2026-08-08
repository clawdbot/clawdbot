// Telegram plugin module implements media file cache behavior.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMediaKind } from "./helpers.js";

type CachedTelegramMediaFile = {
  path: string;
  kind: TelegramMediaKind;
  contentType?: string;
  /** Byte size recorded at download time; checked against the caller's limit. */
  size: number;
  expiresAt: number;
};

// Bounded LRU so a long-lived gateway cannot grow this without limit; entries
// are only local file references, never bytes.
const TELEGRAM_MEDIA_FILE_CACHE_MAX_ENTRIES = 500;

// Entry expiry replaces a per-hit fs.existsSync: hits must not add blocking
// filesystem polls to the inbound hot path. The invariant making this safe is
// owned by core media cleanup: pruneExpired (fs-safe file-store-prune.js)
// deletes only when now - mtimeMs > ttlMs, and ttlMs comes from
// attachments.ttlHours clamped to a 1-hour minimum (resolveMediaCleanupTtlMs);
// when ttlHours is unconfigured the maintenance sweep skips TTL pruning
// entirely. Playback-transcode and managed-outgoing sweepers never touch
// inbound files. Entries therefore expire well before any automated deleter
// can remove the file they point at; only manual deletion inside the window
// can dangle a path, the same best-effort TOCTOU the download path has.
const TELEGRAM_MEDIA_FILE_CACHE_TTL_MS = 55 * 60_000;

// Keyed by file_unique_id, which Telegram keeps stable for the same file even
// when file_id rotates, so a photo downloaded on its original inbound turn can
// be reused when a later reply quotes it.
const mediaFileCache = new Map<string, CachedTelegramMediaFile>();

export function getCachedTelegramMediaFile(
  fileUniqueId: string,
  maxBytes: number,
): CachedTelegramMediaFile | null {
  const entry = mediaFileCache.get(fileUniqueId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    mediaFileCache.delete(fileUniqueId);
    return null;
  }
  // mediaMaxMb is per-account: a file admitted under a larger limit must not
  // be reused by a call enforcing a smaller one. Keep the entry so the
  // original-limit caller can still hit it.
  if (entry.size > maxBytes) {
    return null;
  }
  mediaFileCache.delete(fileUniqueId);
  mediaFileCache.set(fileUniqueId, entry);
  return entry;
}

export function cacheTelegramMediaFile(
  fileUniqueId: string,
  entry: Omit<CachedTelegramMediaFile, "expiresAt">,
): void {
  mediaFileCache.delete(fileUniqueId);
  mediaFileCache.set(fileUniqueId, {
    ...entry,
    expiresAt: Date.now() + TELEGRAM_MEDIA_FILE_CACHE_TTL_MS,
  });
  while (mediaFileCache.size > TELEGRAM_MEDIA_FILE_CACHE_MAX_ENTRIES) {
    const oldest = mediaFileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    mediaFileCache.delete(oldest);
  }
  logVerbose(`telegram: cached media file for ${fileUniqueId}`);
}
