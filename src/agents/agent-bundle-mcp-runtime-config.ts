/** Session MCP config loading, filtering, and catalog fingerprints. */
import crypto from "node:crypto";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { PluginLruCache } from "../plugins/plugin-cache-primitives.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import {
  partitionMcpServersByConnectionScope,
  redactMcpServersForFingerprint,
} from "./mcp-connection-resolver.js";

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedAgentMcpConfig>;
type PreparedSessionMcpConfig = {
  loaded: LoadedMcpConfig;
  fingerprint: string;
};
type SessionMcpConfigDiscoveryCacheEntry = {
  loaded: LoadedMcpConfig;
  preparedByVariant: PluginLruCache<PreparedSessionMcpConfig>;
};

const SESSION_MCP_CONFIG_DISCOVERY_CACHE_KEY = Symbol.for(
  "openclaw.sessionMcpConfigDiscoveryCache.pluginLru.v1",
);
const SESSION_MCP_CONFIG_DISCOVERY_CACHE_LIMIT = 128;
const SESSION_MCP_PREPARED_CONFIG_VARIANT_LIMIT = 64;
const EMPTY_OPENCLAW_CONFIG: OpenClawConfig = {};

type SessionMcpConfigDiscoveryCacheState = {
  entries: PluginLruCache<SessionMcpConfigDiscoveryCacheEntry>;
  manifestRegistryIds: WeakMap<object, number>;
  nextManifestRegistryId: number;
};

function getSessionMcpConfigDiscoveryCacheState(): SessionMcpConfigDiscoveryCacheState {
  return resolveGlobalSingleton(SESSION_MCP_CONFIG_DISCOVERY_CACHE_KEY, () => ({
    entries: new PluginLruCache(SESSION_MCP_CONFIG_DISCOVERY_CACHE_LIMIT),
    manifestRegistryIds: new WeakMap(),
    nextManifestRegistryId: 1,
  }));
}

function resolveManifestRegistryCacheId(
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
): string {
  if (!manifestRegistry) {
    return "discovered";
  }
  const state = getSessionMcpConfigDiscoveryCacheState();
  const identity = manifestRegistry.plugins;
  const existing = state.manifestRegistryIds.get(identity);
  if (existing !== undefined) {
    return String(existing);
  }
  const created = state.nextManifestRegistryId;
  state.nextManifestRegistryId += 1;
  state.manifestRegistryIds.set(identity, created);
  return String(created);
}

function buildSessionMcpConfigDiscoveryCacheKey(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): string {
  return JSON.stringify({
    v: 1,
    workspaceDir: params.workspaceDir,
    config: resolveRuntimeConfigCacheKey(params.cfg ?? EMPTY_OPENCLAW_CONFIG),
    manifestRegistry: resolveManifestRegistryCacheId(params.manifestRegistry),
  });
}

function clonePreparedSessionMcpConfig(
  prepared: PreparedSessionMcpConfig,
): PreparedSessionMcpConfig {
  // Session runtimes own and may normalize their launch config. Keep cached
  // preparation immutable by never exposing its object graph to a caller.
  return structuredClone(prepared);
}

function loadCachedEmbeddedAgentMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): SessionMcpConfigDiscoveryCacheEntry {
  const state = getSessionMcpConfigDiscoveryCacheState();
  const key = buildSessionMcpConfigDiscoveryCacheKey(params);
  const cached = state.entries.get(key);
  if (cached) {
    return cached;
  }
  // Bundle manifests and their MCP JSON are process-stable metadata. Keep the
  // merged discovery result warm; live clients, catalogs, and failures remain
  // session-owned and are never stored here.
  const discovered = structuredClone(loadEmbeddedAgentMcpConfig(params));
  const loaded = {
    loaded: discovered,
    preparedByVariant: new PluginLruCache<PreparedSessionMcpConfig>(
      SESSION_MCP_PREPARED_CONFIG_VARIANT_LIMIT,
    ),
  };
  // Diagnostics can represent transient filesystem or manifest failures. Keep
  // those results session-owned so the next run retries discovery.
  if (discovered.diagnostics.length > 0) {
    return loaded;
  }
  state.entries.set(key, loaded);
  return loaded;
}

function clearSessionMcpConfigDiscoveryCache(): void {
  const state = getSessionMcpConfigDiscoveryCacheState();
  state.entries.clear();
  state.manifestRegistryIds = new WeakMap();
  state.nextManifestRegistryId = 1;
}

registerPluginMetadataProcessMemoLifecycleClear(clearSessionMcpConfigDiscoveryCache);

function digestSafeServerNameAssignments(
  safeServerNamesByServer?: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  if (!safeServerNamesByServer || safeServerNamesByServer.size === 0) {
    return undefined;
  }
  return Object.fromEntries(
    [...safeServerNamesByServer.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

function sortedSetEntries(values?: ReadonlySet<string>): string[] | undefined {
  return values ? [...values].toSorted((a, b) => a.localeCompare(b)) : undefined;
}

function buildPreparedConfigVariantKey(params: {
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  redactConnectionServerNames?: ReadonlySet<string>;
  safeServerNames?: Record<string, string>;
  mcpAppsEnabled: boolean;
}): string {
  return JSON.stringify({
    include: sortedSetEntries(params.includeServerNames),
    exclude: sortedSetEntries(params.excludeServerNames),
    redact: sortedSetEntries(params.redactConnectionServerNames),
    safeServerNames: params.safeServerNames,
    mcpAppsEnabled: params.mcpAppsEnabled,
  });
}

function createCatalogFingerprint(params: {
  servers: Record<string, unknown>;
  mcpAppsEnabled: boolean;
  /** Full-set server→safeName map; assignment changes must invalidate all partitions. */
  safeServerNames?: Record<string, string>;
}): string {
  // Session MCP fingerprints only invalidate in-memory runtime catalogs.
  // Algorithm changes can cause one cache miss, but no persisted state migration.
  // Per-user url/headers never enter this hash (see redactMcpServersForFingerprint).
  return crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

function filterMcpServers<T>(
  mcpServers: Record<string, T>,
  options?: {
    includeServerNames?: ReadonlySet<string>;
    excludeServerNames?: ReadonlySet<string>;
  },
): Record<string, T> {
  if (!options?.includeServerNames && !options?.excludeServerNames) {
    return mcpServers;
  }
  const filtered: Record<string, T> = {};
  for (const [serverName, rawServer] of Object.entries(mcpServers)) {
    if (options.includeServerNames && !options.includeServerNames.has(serverName)) {
      continue;
    }
    if (options.excludeServerNames?.has(serverName)) {
      continue;
    }
    filtered[serverName] = rawServer;
  }
  return filtered;
}

export function loadSessionMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  logDiagnostics?: boolean;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  /** Server names whose url/headers must not affect the fingerprint. */
  redactConnectionServerNames?: ReadonlySet<string>;
  /** Full-set safe-name assignments; folded into fingerprint for all partitions. */
  safeServerNamesByServer?: ReadonlyMap<string, string>;
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
} {
  const discovery = loadCachedEmbeddedAgentMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of discovery.loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  const safeServerNames = digestSafeServerNameAssignments(params.safeServerNamesByServer);
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const variantKey = buildPreparedConfigVariantKey({
    includeServerNames: params.includeServerNames,
    excludeServerNames: params.excludeServerNames,
    redactConnectionServerNames: params.redactConnectionServerNames,
    safeServerNames,
    mcpAppsEnabled,
  });
  const prepared = discovery.preparedByVariant.get(variantKey);
  if (prepared) {
    return clonePreparedSessionMcpConfig(prepared);
  }
  const mcpServers = filterMcpServers(discovery.loaded.mcpServers, {
    includeServerNames: params.includeServerNames,
    excludeServerNames: params.excludeServerNames,
  });
  const fingerprintServers = params.redactConnectionServerNames?.size
    ? redactMcpServersForFingerprint(mcpServers, params.redactConnectionServerNames)
    : mcpServers;
  const result = {
    loaded: {
      ...discovery.loaded,
      mcpServers,
    },
    fingerprint: createCatalogFingerprint({
      servers: fingerprintServers,
      mcpAppsEnabled,
      ...(safeServerNames ? { safeServerNames } : {}),
    }),
  };
  discovery.preparedByVariant.set(variantKey, result);
  return clonePreparedSessionMcpConfig(result);
}

/**
 * Loads enabled MCP config metadata for a session without creating runtimes,
 * connecting transports, or issuing MCP tools/list requests.
 */
export function resolveSessionMcpConfigSummary(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): { fingerprint: string; serverNames: string[] } {
  const { loaded, fingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: false,
    manifestRegistry: params.manifestRegistry,
  });
  const serverNames = Object.keys(loaded.mcpServers).toSorted((a, b) => a.localeCompare(b));
  if (serverNames.length === 0) {
    return { fingerprint, serverNames };
  }
  // Mirror getOrCreate: the bare-keyed runtime folds full-set safe names into
  // its fingerprint and excludes requester-scoped servers from its partition.
  // Compare apples-to-apples or tools.effective reports stale-config forever.
  const safeServerNamesByServer = assignSafeServerNames(Object.keys(loaded.mcpServers));
  const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(loaded.mcpServers);
  const { fingerprint: bareRuntimeFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: false,
    manifestRegistry: params.manifestRegistry,
    ...(requesterScopedServerNames.length > 0
      ? { excludeServerNames: new Set(requesterScopedServerNames) }
      : {}),
    safeServerNamesByServer,
  });
  return { fingerprint: bareRuntimeFingerprint, serverNames };
}
