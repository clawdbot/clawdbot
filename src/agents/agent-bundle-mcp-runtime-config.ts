/** Session MCP config loading, filtering, and catalog fingerprints. */
import crypto from "node:crypto";
import type { SessionToolOverrides } from "../config/sessions/types.js";
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

function digestMcpToolDenials(
  value?: Record<string, string[]>,
): Record<string, string[]> | undefined {
  const entries = Object.entries(value ?? {})
    .map(
      ([serverName, toolNames]) =>
        [
          serverName,
          [...new Set(toolNames)].toSorted((left, right) => left.localeCompare(right)),
        ] as const,
    )
    .filter(([, toolNames]) => toolNames.length > 0)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function createCatalogFingerprint(params: {
  servers: Record<string, unknown>;
  mcpAppsEnabled: boolean;
  /** Full-set server→safeName map; assignment changes must invalidate all partitions. */
  safeServerNames?: Record<string, string>;
  mcpToolsDeny?: Record<string, string[]>;
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
  loaded?: LoadedMcpConfig;
  logDiagnostics?: boolean;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  /** Server names whose url/headers must not affect the fingerprint. */
  redactConnectionServerNames?: ReadonlySet<string>;
  /** Full-set safe-name assignments; folded into fingerprint for all partitions. */
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
} {
  const loaded =
    params.loaded ??
    loadEmbeddedAgentMcpConfig({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      toolOverrides: params.toolOverrides,
    });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  const safeServerNames = digestSafeServerNameAssignments(params.safeServerNamesByServer);
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const mcpToolsDeny = digestMcpToolDenials(params.toolOverrides?.mcpToolsDeny);
  const mcpServers = filterMcpServers(loaded.mcpServers, {
    includeServerNames: params.includeServerNames,
    excludeServerNames: params.excludeServerNames,
  });
  const prepareDataDirsByServer = Object.fromEntries(
    Object.entries(loaded.prepareDataDirsByServer ?? {}).filter(([serverName]) =>
      Object.hasOwn(mcpServers, serverName),
    ),
  );
  const fingerprintServers = params.redactConnectionServerNames?.size
    ? redactMcpServersForFingerprint(mcpServers, params.redactConnectionServerNames)
    : mcpServers;
  const result = {
    loaded: {
      ...loaded,
      mcpServers,
      // Launch ownership is not serialized or fingerprinted; the injected env path already
      // participates in the server fingerprint and this sidecar only authorizes mkdir.
      prepareDataDirsByServer,
    },
    fingerprint: createCatalogFingerprint({
      servers: fingerprintServers,
      mcpAppsEnabled,
      ...(safeServerNames ? { safeServerNames } : {}),
      mcpToolsDeny,
    }),
  };
  // Launch normalization is session-owned; never expose cached package facts or user config.
  return structuredClone(result);
}

/**
 * Loads enabled MCP config metadata for a session without creating runtimes,
 * connecting transports, or issuing MCP tools/list requests.
 */
export function resolveSessionMcpConfigSummary(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}): { fingerprint: string; serverNames: string[] } {
  const loaded = loadEmbeddedAgentMcpConfig(params);
  const declaredServerNames = Object.keys(loaded.mcpServers);
  const serverNames = declaredServerNames.toSorted((a, b) => a.localeCompare(b));
  // Mirror getOrCreate: the bare-keyed runtime folds full-set safe names into
  // its fingerprint and excludes requester-scoped servers from its partition.
  // Compare apples-to-apples or tools.effective reports stale-config forever.
  const safeServerNamesByServer = assignSafeServerNames(declaredServerNames);
  const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(loaded.mcpServers);
  const { fingerprint } = loadSessionMcpConfig({
    ...params,
    loaded,
    logDiagnostics: false,
    ...(requesterScopedServerNames.length > 0
      ? { excludeServerNames: new Set(requesterScopedServerNames) }
      : {}),
    safeServerNamesByServer,
  });
  return { fingerprint, serverNames };
}

/** Reads the enabled static MCP server set without opening transports or listing tools. */
export function resolveStaticSessionMcpServerNames(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}): string[] {
  const { loaded } = loadSessionMcpConfig({
    ...params,
    logDiagnostics: false,
  });
  const { staticServers } = partitionMcpServersByConnectionScope(loaded.mcpServers);
  return Object.keys(staticServers).toSorted((left, right) => left.localeCompare(right));
}
