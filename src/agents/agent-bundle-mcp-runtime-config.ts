/** Session MCP config loading, filtering, and catalog fingerprints. */
import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import {
  partitionMcpServersByConnectionScope,
  redactMcpServersForFingerprint,
} from "./mcp-connection-resolver.js";

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedAgentMcpConfig>;

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
  const loaded = loadEmbeddedAgentMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  const mcpServers = filterMcpServers(loaded.mcpServers, {
    includeServerNames: params.includeServerNames,
    excludeServerNames: params.excludeServerNames,
  });
  const fingerprintServers = params.redactConnectionServerNames?.size
    ? redactMcpServersForFingerprint(mcpServers, params.redactConnectionServerNames)
    : mcpServers;
  const safeServerNames = digestSafeServerNameAssignments(params.safeServerNamesByServer);
  return {
    loaded: {
      ...loaded,
      mcpServers,
    },
    fingerprint: createCatalogFingerprint({
      servers: fingerprintServers,
      mcpAppsEnabled: params.cfg?.mcp?.apps?.enabled === true,
      ...(safeServerNames ? { safeServerNames } : {}),
    }),
  };
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
