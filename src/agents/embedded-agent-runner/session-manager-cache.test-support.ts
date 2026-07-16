import fs from "node:fs/promises";
import "./session-manager-cache.js";

type SessionManagerCache = {
  clear(): void;
  isSessionManagerCached(sessionFile: string): boolean;
  keys(): string[];
  prewarmSessionFile(sessionFile: string): Promise<void>;
  trackSessionManagerAccess(sessionFile: string): void;
};

type SessionManagerCacheTestApi = {
  createSessionManagerCache(options?: {
    clock?: () => number;
    fsModule?: Pick<typeof fs, "open">;
    ttlMs?: number | (() => number);
  }): SessionManagerCache;
};

function getTestApi(): SessionManagerCacheTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionManagerCacheTestApi")
  ];
  if (!api) {
    throw new Error("session manager cache test API is unavailable");
  }
  return api as SessionManagerCacheTestApi;
}

export const createSessionManagerCache: SessionManagerCacheTestApi["createSessionManagerCache"] = (
  options,
) => getTestApi().createSessionManagerCache(options);
