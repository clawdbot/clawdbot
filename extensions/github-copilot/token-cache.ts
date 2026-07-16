import { createHash } from "node:crypto";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { COPILOT_INTEGRATION_ID } from "openclaw/plugin-sdk/provider-auth";
import { PUBLIC_GITHUB_COPILOT_DOMAIN } from "./domain.js";

export const COPILOT_TOKEN_CACHE_NAMESPACE = "token";
export const COPILOT_TOKEN_CACHE_MAX_ENTRIES = 8;

export type CachedCopilotToken = {
  token: string;
  expiresAt: number;
  updatedAt: number;
  integrationId?: string;
  sourceCredentialFingerprint?: string;
  domain?: string;
};

export function fingerprintCopilotSourceCredential(githubToken: string): string {
  return createHash("sha256").update(githubToken).digest("hex");
}

export function isCopilotTokenUsable(params: {
  cache: CachedCopilotToken;
  domain: string;
  sourceCredentialFingerprint: string;
  now?: number;
}): boolean {
  const expiresAt = asDateTimestampMs(params.cache.expiresAt);
  // Pre-domain cache entries were public-only. Keep public upgrades warm while
  // forcing tenant requests to exchange a tenant-scoped token.
  const cacheDomain = params.cache.domain ?? PUBLIC_GITHUB_COPILOT_DOMAIN;
  return (
    params.cache.integrationId === COPILOT_INTEGRATION_ID &&
    cacheDomain === params.domain &&
    params.cache.sourceCredentialFingerprint === params.sourceCredentialFingerprint &&
    expiresAt !== undefined &&
    expiresAt - (params.now ?? Date.now()) > 5 * 60 * 1000
  );
}

type CopilotTokenCache = {
  path: string;
  load(): CachedCopilotToken | undefined;
  save(value: CachedCopilotToken): void;
};

export function resolveCopilotTokenCache(params: {
  domain: string;
  sourceCredentialFingerprint: string;
  openCacheStore?: () => PluginStateSyncKeyedStore<CachedCopilotToken>;
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): CopilotTokenCache {
  const usesExplicitCacheAdapter =
    params.cachePath !== undefined ||
    params.loadJsonFileImpl !== undefined ||
    params.saveJsonFileImpl !== undefined;
  if (usesExplicitCacheAdapter) {
    // Explicit file adapters are test/compat seams only. Runtime state is SQLite.
    const cachePath = params.cachePath?.trim() || "explicit-cache";
    const loadJsonFileFn = params.loadJsonFileImpl ?? (() => undefined);
    const saveJsonFileFn = params.saveJsonFileImpl ?? (() => undefined);
    return {
      path: cachePath,
      load: () => loadJsonFileFn(cachePath) as CachedCopilotToken | undefined,
      save: (value) => saveJsonFileFn(cachePath, value),
    };
  }

  const store = params.openCacheStore?.();
  if (!store) {
    // Direct live/tests may call the provider helper without plugin registration.
    // They exchange normally but do not persist runtime state outside SQLite.
    return {
      path: "uncached",
      load: () => undefined,
      save: () => undefined,
    };
  }
  const key = `${params.domain}:${params.sourceCredentialFingerprint}`;
  return {
    path: "plugin-state",
    load: () => store.lookup(key),
    save: (value) =>
      store.register(key, value, {
        ttlMs: Math.max(1, value.expiresAt - Date.now()),
      }),
  };
}
