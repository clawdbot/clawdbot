import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  discoverOpenClawPlugins,
  type PluginCandidate,
  type PluginDiscoveryResult,
} from "./discovery.js";
import { pluginLoaderCacheState } from "./loader-cache.js";
import type { PluginLoadCacheContext } from "./loader-load-context.js";
import {
  buildProvenanceIndex,
  compareDuplicateCandidateOrder,
  warnWhenAllowlistIsOpen,
} from "./loader-provenance.js";
import { createPluginCandidatesFromManifestRegistry, pushDiagnostics } from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginLogger } from "./types.js";

type ResolvedPluginLoadDiscovery = {
  discovery: PluginDiscoveryResult;
  manifestRegistry: PluginManifestRegistry;
  orderedCandidates: PluginCandidate[];
  manifestByRoot: Map<string, PluginManifestRecord>;
  provenance: ReturnType<typeof buildProvenanceIndex>;
};

export function resolvePluginLoadDiscovery(params: {
  options: PluginLoadOptions;
  context: PluginLoadCacheContext;
  diagnostics: PluginDiagnostic[];
  logger: PluginLogger;
  onlyPluginIdSet: ReadonlySet<string> | null;
  emitWarning: boolean;
  warningCacheKey: string;
  suppliedManifestRegistry?: PluginManifestRegistry;
}): ResolvedPluginLoadDiscovery {
  const { options, context } = params;
  const discovery = params.suppliedManifestRegistry
    ? {
        candidates: createPluginCandidatesFromManifestRegistry(params.suppliedManifestRegistry),
        diagnostics: [] as PluginDiagnostic[],
      }
    : (options.discovery ??
      discoverOpenClawPlugins({
        workspaceDir: options.workspaceDir,
        extraPaths: context.normalized.loadPaths,
        env: context.env,
        installRecords: context.installRecords,
      }));
  const manifestRegistry =
    params.suppliedManifestRegistry ??
    loadPluginManifestRegistry({
      config: context.cfg,
      workspaceDir: options.workspaceDir,
      env: context.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
      installRecords: nonEmptyInstallRecords(context.installRecords),
    });
  pushDiagnostics(params.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    emitWarning: params.emitWarning,
    logger: params.logger,
    pluginsEnabled: context.normalized.enabled,
    allow: context.normalized.allow,
    warningCacheKey: params.warningCacheKey,
    warningCache: pluginLoaderCacheState,
    explicitlyEnabledPluginIds: new Set(
      Object.entries(context.normalized.entries)
        .filter(([, entry]) => entry.enabled === true)
        .map(([pluginId]) => pluginId),
    ),
    // Partial snapshots should only warn about plugins intentionally in scope.
    discoverablePlugins: manifestRegistry.plugins
      .filter((plugin) => !params.onlyPluginIdSet || params.onlyPluginIdSet.has(plugin.id))
      .map((plugin) => ({
        id: plugin.id,
        source: plugin.source,
        origin: plugin.origin,
      })),
  });
  const provenance = buildProvenanceIndex({
    normalizedLoadPaths: context.normalized.loadPaths,
    env: context.env,
    installRecords: context.installRecords,
  });
  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const orderedCandidates = [...discovery.candidates].toSorted((left, right) =>
    compareDuplicateCandidateOrder({
      left,
      right,
      manifestByRoot,
      provenance,
      env: context.env,
    }),
  );
  return { discovery, manifestRegistry, orderedCandidates, manifestByRoot, provenance };
}

function nonEmptyInstallRecords(
  records: Record<string, PluginInstallRecord>,
): Record<string, PluginInstallRecord> | undefined {
  return Object.keys(records).length > 0 ? records : undefined;
}
