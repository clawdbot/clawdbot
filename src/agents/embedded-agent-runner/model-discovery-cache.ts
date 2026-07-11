/**
 * Discovers cached model/provider state from configured agent stores.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveRuntimeExternalAuthProviderRefs,
  resolveRuntimeSyntheticAuthProviderRefs,
} from "../../plugins/synthetic-auth.runtime.js";
import { discoverAuthStorage, discoverModels } from "../agent-model-discovery.js";
import { resolveDefaultAgentDir } from "../agent-scope.js";
import { hasAnyRuntimeAuthProfileStoreSource } from "../auth-profiles/runtime-snapshots.js";
import { resolveModelPluginMetadataSnapshot } from "../model-discovery-context.js";
import { listPluginModelCatalogFiles } from "../plugin-model-catalog.js";
import type { AuthStorage, ModelRegistry } from "../sessions/index.js";

/**
 * Caches auth/model discovery for embedded-agent turns that reuse a stable agent directory.
 *
 * Runtime auth profile stores and live plugin auth sources bypass this cache because their
 * source of truth can change without file metadata updates in the agent directory.
 */
type DiscoveryStores = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
};

type DiscoverCachedAgentStoresOptions = {
  agentDir: string;
  config?: OpenClawConfig;
  inheritedAuthDir?: string;
  workspaceDir?: string;
};

type CacheEntry = DiscoveryStores & {
  fingerprint: string;
  lastUsedAt: number;
};

const MAX_DISCOVERY_STORE_CACHE_ENTRIES = 64;
const DISCOVERY_STORE_CACHE = new Map<string, CacheEntry>();

/** Returns the small file metadata tuple used to invalidate cached discovery snapshots. */
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
    authProfilesSqlite: fileFingerprint(path.join(agentDir, "openclaw-agent.sqlite")),
    authProfilesSqliteWal: fileFingerprint(path.join(agentDir, "openclaw-agent.sqlite-wal")),
  };
}

function pluginModelCatalogFingerprint(
  agentDir: string,
): Array<[string, ReturnType<typeof fileFingerprint>]> {
  return listPluginModelCatalogFiles(agentDir).map((catalogFile) => [
    catalogFile.relativePath,
    fileFingerprint(catalogFile.path),
  ]);
}

function discoveryFingerprint(
  params: DiscoverCachedAgentStoresOptions & {
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): string {
  // Only include inherited auth when it points at a distinct store. The common same-dir case must
  // not double-count WAL/file state or it would churn cache keys without changing discovery output.
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
    // Discovery normalization can project provider/model route facts from config.
    // Tie the registry snapshot to that same runtime config generation.
    runtimeConfig: params.config ? resolveRuntimeConfigCacheKey(params.config) : undefined,
    pluginMetadata: pluginMetadataFingerprint(params.pluginMetadataSnapshot),
    pluginModelCatalogs: pluginModelCatalogFingerprint(params.agentDir),
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

function resolvePluginMetadataSnapshotForDiscovery(
  options: DiscoverCachedAgentStoresOptions,
): PluginMetadataSnapshot | undefined {
  return resolveModelPluginMetadataSnapshot({
    ...(options.config ? { config: options.config } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    useRuntimeConfig: options.config === undefined,
  }) as PluginMetadataSnapshot | undefined;
}

function pluginMetadataFingerprint(snapshot: PluginMetadataSnapshot | undefined): object {
  return {
    configFingerprint: snapshot?.configFingerprint,
    policyHash: snapshot?.policyHash,
    workspaceDir: snapshot?.workspaceDir,
  };
}

function discoverFreshAgentStores(
  agentDir: string,
  options: Pick<DiscoverCachedAgentStoresOptions, "config" | "workspaceDir">,
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined,
): DiscoveryStores {
  const authStorage = discoverAuthStorage(agentDir);
  const modelRegistry = discoverModels(authStorage, agentDir, {
    ...(options.config ? { config: options.config } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  });
  return { authStorage, modelRegistry };
}

/** Discovers auth/model stores, reusing file-backed snapshots until their inputs change. */
export function discoverCachedAgentStores(
  options: DiscoverCachedAgentStoresOptions,
): DiscoveryStores {
  const agentDir = normalizeCacheDir(options.agentDir) ?? options.agentDir;
  const inheritedAuthDir = normalizeCacheDir(
    options.inheritedAuthDir ?? resolveDefaultAgentDir({}),
  );
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir) || hasRuntimePluginAuthSources()) {
    // Runtime profile sources are process-owned state, not file-backed metadata. Fresh discovery
    // preserves provider/auth changes made during the same long-lived gateway process.
    return discoverFreshAgentStores(
      agentDir,
      options,
      resolvePluginMetadataSnapshotForDiscovery(options),
    );
  }
  const pluginMetadataSnapshot = resolvePluginMetadataSnapshotForDiscovery(options);

  const cacheKey = JSON.stringify({ agentDir, inheritedAuthDir });
  const fingerprint = discoveryFingerprint({
    agentDir,
    config: options.config,
    inheritedAuthDir,
    pluginMetadataSnapshot,
  });
  const cached = DISCOVERY_STORE_CACHE.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    cached.lastUsedAt = Date.now();
    return {
      authStorage: cached.authStorage,
      modelRegistry: cached.modelRegistry,
    };
  }

  const stores = discoverFreshAgentStores(agentDir, options, pluginMetadataSnapshot);
  DISCOVERY_STORE_CACHE.set(cacheKey, {
    authStorage: stores.authStorage,
    fingerprint,
    lastUsedAt: Date.now(),
    modelRegistry: stores.modelRegistry,
  });
  pruneDiscoveryStoreCache();
  return stores;
}

/** Clears the process-local discovery cache between tests that mutate model/auth fixtures. */
export function resetModelDiscoveryCacheForTest(): void {
  DISCOVERY_STORE_CACHE.clear();
}
