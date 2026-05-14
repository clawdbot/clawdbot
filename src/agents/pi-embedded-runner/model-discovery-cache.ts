import { statSync } from "node:fs";
import path from "node:path";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  resolveRuntimeExternalAuthProviderRefs,
  resolveRuntimeSyntheticAuthProviderRefs,
} from "../../plugins/synthetic-auth.runtime.js";
import { resolveDefaultAgentDir } from "../agent-scope.js";
import { hasAnyRuntimeAuthProfileStoreSource } from "../auth-profiles/runtime-snapshots.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";

type DiscoveryStores = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
};

type DiscoverCachedPiStoresOptions = {
  agentDir: string;
  inheritedAuthDir?: string;
};

type CacheEntry = DiscoveryStores & {
  fingerprint: string;
  lastUsedAt: number;
};

const MAX_DISCOVERY_STORE_CACHE_ENTRIES = 64;
const DISCOVERY_STORE_CACHE = new Map<string, CacheEntry>();

function fileFingerprint(pathname: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(pathname);
    return Number.isFinite(stat.mtimeMs) ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

function normalizeCacheDir(dirname: string | undefined): string | undefined {
  return dirname ? path.resolve(dirname) : undefined;
}

function authFingerprint(agentDir: string): object {
  return {
    authJson: fileFingerprint(path.join(agentDir, "auth.json")),
    authProfilesJson: fileFingerprint(path.join(agentDir, "auth-profiles.json")),
  };
}

function discoveryFingerprint(params: DiscoverCachedPiStoresOptions): string {
  const inheritedAuthDir =
    params.inheritedAuthDir && params.inheritedAuthDir !== params.agentDir
      ? params.inheritedAuthDir
      : undefined;
  return JSON.stringify({
    agentDir: params.agentDir,
    inheritedAuthDir,
    localAuth: authFingerprint(params.agentDir),
    inheritedAuth: inheritedAuthDir ? authFingerprint(inheritedAuthDir) : undefined,
    modelsJson: fileFingerprint(path.join(params.agentDir, "models.json")),
  });
}

function hasRuntimePluginAuthSources(): boolean {
  return (
    resolveRuntimeSyntheticAuthProviderRefs().length > 0 ||
    resolveRuntimeExternalAuthProviderRefs().length > 0
  );
}

function pruneDiscoveryStoreCache(): void {
  if (DISCOVERY_STORE_CACHE.size <= MAX_DISCOVERY_STORE_CACHE_ENTRIES) {
    return;
  }
  const overflow = DISCOVERY_STORE_CACHE.size - MAX_DISCOVERY_STORE_CACHE_ENTRIES;
  const oldestKeys = [...DISCOVERY_STORE_CACHE.entries()]
    .toSorted((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    .slice(0, overflow)
    .map(([key]) => key);
  for (const key of oldestKeys) {
    DISCOVERY_STORE_CACHE.delete(key);
  }
}

function discoverFreshPiStores(agentDir: string): DiscoveryStores {
  const authStorage = discoverAuthStorage(agentDir);
  const modelRegistry = discoverModels(authStorage, agentDir);
  return { authStorage, modelRegistry };
}

export function discoverCachedPiStores(options: DiscoverCachedPiStoresOptions): DiscoveryStores {
  const agentDir = normalizeCacheDir(options.agentDir) ?? options.agentDir;
  const inheritedAuthDir = normalizeCacheDir(
    options.inheritedAuthDir ?? resolveDefaultAgentDir({}),
  );
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir) || hasRuntimePluginAuthSources()) {
    return discoverFreshPiStores(agentDir);
  }

  const cacheKey = JSON.stringify({ agentDir, inheritedAuthDir });
  const fingerprint = discoveryFingerprint({ agentDir, inheritedAuthDir });
  const cached = DISCOVERY_STORE_CACHE.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    cached.lastUsedAt = Date.now();
    return {
      authStorage: cached.authStorage,
      modelRegistry: cached.modelRegistry,
    };
  }

  const stores = discoverFreshPiStores(agentDir);
  DISCOVERY_STORE_CACHE.set(cacheKey, {
    authStorage: stores.authStorage,
    fingerprint,
    lastUsedAt: Date.now(),
    modelRegistry: stores.modelRegistry,
  });
  pruneDiscoveryStoreCache();
  return stores;
}

export function resetModelDiscoveryCacheForTest(): void {
  DISCOVERY_STORE_CACHE.clear();
}
