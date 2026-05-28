import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import {
  createExpiringMapCache,
  isCacheEnabled,
  resolveCacheTtlMs,
} from "../../config/cache-utils.js";

const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds
const MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 1_000;
const MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 30_000;

function getSessionManagerTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS,
  });
}

function resolveSessionManagerCachePruneInterval(ttlMs: number): number {
  return Math.min(
    Math.max(ttlMs, MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS),
    MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS,
  );
}

export type SessionManagerCache = {
  clear: () => void;
  isSessionManagerCached: (sessionFile: string) => boolean;
  keys: () => string[];
  prewarmSessionFile: (sessionFile: string) => Promise<void>;
  trackSessionManagerAccess: (sessionFile: string) => void;
};

export function createSessionManagerCache(options?: {
  clock?: () => number;
  fsModule?: Pick<typeof fs, "open">;
  ttlMs?: number | (() => number);
}): SessionManagerCache {
  const getTtlMs = () =>
    typeof options?.ttlMs === "function"
      ? options.ttlMs()
      : (options?.ttlMs ?? getSessionManagerTtl());
  const cache = createExpiringMapCache<string, true>({
    ttlMs: getTtlMs,
    pruneIntervalMs: resolveSessionManagerCachePruneInterval,
    clock: options?.clock,
  });
  const fsModule = options?.fsModule ?? fs;

  return {
    clear: () => {
      cache.clear();
    },
    isSessionManagerCached: (sessionFile) => cache.get(sessionFile) === true,
    keys: () => cache.keys(),
    prewarmSessionFile: async (sessionFile) => {
      if (!isCacheEnabled(getTtlMs())) {
        return;
      }
      if (cache.get(sessionFile) === true) {
        return;
      }

      try {
        // Read a small chunk to encourage OS page cache warmup.
        const handle = await fsModule.open(sessionFile, "r");
        try {
          const buffer = Buffer.alloc(4096);
          await handle.read(buffer, 0, buffer.length, 0);
        } finally {
          await handle.close();
        }
        cache.set(sessionFile, true);
      } catch {
        // File doesn't exist yet, SessionManager will create it
      }
    },
    trackSessionManagerAccess: (sessionFile) => {
      cache.set(sessionFile, true);
    },
  };
}

const sessionManagerCache = createSessionManagerCache();

export function trackSessionManagerAccess(sessionFile: string): void {
  sessionManagerCache.trackSessionManagerAccess(sessionFile);
}

export async function prewarmSessionFile(sessionFile: string): Promise<void> {
  await sessionManagerCache.prewarmSessionFile(sessionFile);
}
