import {
  discoverOpenClawPlugins,
  type PluginCandidate,
  type PluginDiscoveryResult,
} from "./discovery.js";
import { pluginLoaderCacheState } from "./loader-cache.js";
import type { PluginLoadCacheContext } from "./loader-load-context.js";
import { buildProvenanceIndex, warnWhenAllowlistIsOpen } from "./loader-provenance.js";
import { createPluginCandidatesFromManifestRegistry, pushDiagnostics } from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginLogger } from "./types.js";

type ResolvedPluginLoadDiscovery = {
  discovery: PluginDiscoveryResult;
  manifestRegistry: PluginManifestRegistry;
  orderedCandidates: PluginCandidate[];
  manifestBySource: Map<string, PluginManifestRecord>;
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
  // The load context has already verified workspace, environment, config, and
  // plugin scope against the current lifecycle-owned metadata generation.
  const suppliedManifestRegistry =
    params.suppliedManifestRegistry ??
    (options.discovery === undefined ? context.metadataSnapshot?.manifestRegistry : undefined);
  const discovery = suppliedManifestRegistry
    ? {
        candidates: createPluginCandidatesFromManifestRegistry(suppliedManifestRegistry),
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
    suppliedManifestRegistry ??
    loadPluginManifestRegistryCore({
      config: context.cfg,
      workspaceDir: options.workspaceDir,
      env: context.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
      installRecords:
        Object.keys(context.installRecords).length > 0 ? context.installRecords : undefined,
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
  const manifestBySource = new Map(
    manifestRegistry.plugins.map((record) => [record.source, record]),
  );
  // Manifest selection owns duplicate precedence; runtime consumes only its winners.
  const orderedCandidates = discovery.candidates.filter((candidate) =>
    manifestBySource.has(candidate.source),
  );
  return { discovery, manifestRegistry, orderedCandidates, manifestBySource, provenance };
}
