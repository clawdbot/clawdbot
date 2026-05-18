import { cloneAuthProfileStore } from "./clone.js";
import { EXTERNAL_CLI_SYNC_TTL_MS } from "./constants.js";
import type { AuthProfileStore } from "./types.js";

const loadedAuthStoreCache = new Map<
  string,
  {
    authMtimeMs: number | null;
    stateMtimeMs: number | null;
    syncedAtMs: number;
    store: AuthProfileStore;
  }
>();

export function readCachedAuthProfileStore(params: {
  authPath: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
}): AuthProfileStore | null {
  const cached = loadedAuthStoreCache.get(params.authPath);
  if (
    !cached ||
    cached.authMtimeMs !== params.authMtimeMs ||
    cached.stateMtimeMs !== params.stateMtimeMs
  ) {
    return null;
  }
  if (Date.now() - cached.syncedAtMs >= EXTERNAL_CLI_SYNC_TTL_MS) {
    return null;
  }
  return cloneAuthProfileStore(cached.store);
}

export function writeCachedAuthProfileStore(params: {
  authPath: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
  store: AuthProfileStore;
}): void {
  loadedAuthStoreCache.set(params.authPath, {
    authMtimeMs: params.authMtimeMs,
    stateMtimeMs: params.stateMtimeMs,
    syncedAtMs: Date.now(),
    store: cloneAuthProfileStore(params.store),
  });
}

export function clearLoadedAuthStoreCache(): void {
  loadedAuthStoreCache.clear();
}
