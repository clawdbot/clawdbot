// Bounded data-URL cache for locally resolved assistant avatars. Kept apart
// from the avatar projection so cache policy (identity validation, LRU bound)
// stays independently testable with injected read/close seams.
import fs from "node:fs";
import {
  readOpenedLocalAgentAvatarDataUrl,
  type OpenedLocalAgentAvatarFile,
} from "../agents/identity-avatar-file.js";

type AvatarDataUrlCacheEntry = {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  dataUrl: string;
};

const GATEWAY_AVATAR_DATA_URL_CACHE_MAX_ENTRIES = 4;

export function createGatewayAvatarDataUrlCache(params?: {
  maxEntries?: number;
  read?: (opened: OpenedLocalAgentAvatarFile) => string | undefined;
  close?: (fd: number) => void;
}) {
  const maxEntries = params?.maxEntries ?? GATEWAY_AVATAR_DATA_URL_CACHE_MAX_ENTRIES;
  const read = params?.read ?? readOpenedLocalAgentAvatarDataUrl;
  const close = params?.close ?? ((fd: number) => fs.closeSync(fd));
  const entries = new Map<string, AvatarDataUrlCacheEntry>();
  return {
    read(opened: OpenedLocalAgentAvatarFile): string | undefined {
      const cached = entries.get(opened.path);
      if (
        cached &&
        cached.ctimeMs === opened.stat.ctimeMs &&
        cached.dev === opened.stat.dev &&
        cached.ino === opened.stat.ino &&
        cached.mtimeMs === opened.stat.mtimeMs &&
        cached.size === opened.stat.size
      ) {
        close(opened.fd);
        entries.delete(opened.path);
        entries.set(opened.path, cached);
        return cached.dataUrl;
      }
      entries.delete(opened.path);
      const dataUrl = read(opened);
      if (!dataUrl || maxEntries <= 0) {
        return dataUrl;
      }
      // The boundary-safe open already fstats the pinned descriptor. Reuse base64
      // only while its file identity and mtime/size match; otherwise an atomic
      // same-size replacement could leave stale identity data indefinitely.
      entries.set(opened.path, {
        ctimeMs: opened.stat.ctimeMs,
        dev: opened.stat.dev,
        ino: opened.stat.ino,
        mtimeMs: opened.stat.mtimeMs,
        size: opened.stat.size,
        dataUrl,
      });
      while (entries.size > maxEntries) {
        const oldestPath = entries.keys().next().value;
        if (oldestPath === undefined) {
          break;
        }
        entries.delete(oldestPath);
      }
      return dataUrl;
    },
  };
}
