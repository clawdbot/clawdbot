// Shares web provider runtime helpers across plugin-owned providers.
import { withActivatedPluginIds } from "./activation-context.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginId } from "./config-state.js";
import { isPluginRegistryLoadInFlight, loadOpenClawPlugins } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { hasExplicitPluginIdScope, normalizePluginIdScope } from "./plugin-scope.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";

/** Shared options for resolving plugin-backed web providers. */
type ResolvePluginWebProvidersParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
  sandboxed?: boolean;
  manifestRecords?: readonly PluginManifestRecord[];
};

type ResolveWebProviderRuntimeDeps<TEntry> = {
  resolveBundledResolutionConfig: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    manifestRecords?: readonly PluginManifestRecord[];
  }) => {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
    manifestRecords?: readonly PluginManifestRecord[];
  };
  resolveCandidatePluginIds: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
    sandboxed?: boolean;
    manifestRecords?: readonly PluginManifestRecord[];
  }) => string[] | undefined;
  mapRegistryProviders: (params: {
    registry: PluginRegistry;
    onlyPluginIds?: readonly string[];
  }) => TEntry[];
  resolveBundledPublicArtifactProviders?: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    manifestRecords?: readonly PluginManifestRecord[];
  }) => TEntry[] | null;
  resolveBundledRuntimeArtifactProviders?: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds: readonly string[];
    manifestRecords?: readonly PluginManifestRecord[];
  }) => TEntry[] | null;
};

type WebProviderRuntimeContext = {
  env: NonNullable<PluginLoadOptions["env"]>;
  workspaceDir?: string;
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
  manifestRecords?: readonly PluginManifestRecord[];
  preparedManifestRegistry?: PluginManifestRegistry;
  loadPluginIds?: string[];
  onlyPluginIds?: string[];
};

function resolveWebProviderRuntimeContext<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): WebProviderRuntimeContext {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const shouldFilterProviders =
    params.config !== undefined ||
    params.onlyPluginIds !== undefined ||
    params.origin !== undefined ||
    params.sandboxed === true;
  const { config, activationSourceConfig, autoEnabledReasons, manifestRecords } =
    deps.resolveBundledResolutionConfig({
      ...params,
      workspaceDir,
      env,
    });
  const discoveredPluginIds = normalizePluginIdScope(
    deps.resolveCandidatePluginIds({
      config: params.config,
      workspaceDir,
      env,
      onlyPluginIds: params.onlyPluginIds,
      origin: params.origin,
      sandboxed: params.sandboxed,
      ...(manifestRecords ? { manifestRecords } : {}),
    }),
  );
  const allowedPluginIds = config?.plugins?.allow;
  const allowSet = allowedPluginIds?.length
    ? new Set(allowedPluginIds.map((pluginId) => normalizePluginId(pluginId)))
    : undefined;
  const allowlistedPluginIds = allowSet
    ? discoveredPluginIds?.filter((pluginId) => allowSet.has(normalizePluginId(pluginId)))
    : discoveredPluginIds;
  const candidatePluginIds = allowlistedPluginIds?.length
    ? allowlistedPluginIds
    : discoveredPluginIds;
  return {
    activationSourceConfig,
    autoEnabledReasons,
    config,
    env,
    manifestRecords,
    ...(params.manifestRecords
      ? { preparedManifestRegistry: { plugins: [...params.manifestRecords], diagnostics: [] } }
      : {}),
    loadPluginIds: candidatePluginIds,
    onlyPluginIds: shouldFilterProviders ? candidatePluginIds : undefined,
    workspaceDir,
  };
}

function resolveWebProviderLoadOptions(
  context: WebProviderRuntimeContext,
  params: ResolvePluginWebProvidersParams,
) {
  return buildPluginRuntimeLoadOptionsFromValues(
    {
      env: context.env,
      config: context.config,
      activationSourceConfig: context.activationSourceConfig,
      autoEnabledReasons: context.autoEnabledReasons,
      workspaceDir: context.workspaceDir,
      logger: createPluginRuntimeLoaderLogger(),
      ...(context.preparedManifestRegistry
        ? { manifestRegistry: context.preparedManifestRegistry }
        : {}),
    },
    {
      cache: params.cache ?? true,
      activate: params.activate ?? false,
      ...(hasExplicitPluginIdScope(context.loadPluginIds)
        ? { onlyPluginIds: context.loadPluginIds }
        : {}),
    },
  );
}

/** Resolves plugin web providers from setup, active runtime, or a scoped load. */
export function resolvePluginWebProviders<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): TEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  if (params.mode === "setup") {
    const pluginIds =
      deps.resolveCandidatePluginIds({
        config: params.config,
        workspaceDir,
        env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
        sandboxed: params.sandboxed,
        ...(params.manifestRecords ? { manifestRecords: params.manifestRecords } : {}),
      }) ?? [];
    if (pluginIds.length === 0) {
      return [];
    }
    if (params.activate !== true) {
      const bundledArtifactProviders = deps.resolveBundledPublicArtifactProviders?.({
        config: params.config,
        workspaceDir,
        env,
        onlyPluginIds: pluginIds,
        ...(params.manifestRecords ? { manifestRecords: params.manifestRecords } : {}),
      });
      if (bundledArtifactProviders) {
        return bundledArtifactProviders;
      }
    }
    const registry = loadOpenClawPlugins(
      buildPluginRuntimeLoadOptionsFromValues(
        {
          config: withActivatedPluginIds({
            config: params.config,
            pluginIds,
          }),
          activationSourceConfig: params.config,
          autoEnabledReasons: {},
          workspaceDir,
          env,
          logger: createPluginRuntimeLoaderLogger(),
          ...(params.manifestRecords
            ? { manifestRegistry: { plugins: [...params.manifestRecords], diagnostics: [] } }
            : {}),
        },
        {
          onlyPluginIds: pluginIds,
          cache: params.cache ?? true,
          activate: params.activate ?? false,
        },
      ),
    );
    return deps.mapRegistryProviders({ registry, onlyPluginIds: pluginIds });
  }

  const context = resolveWebProviderRuntimeContext(params, deps);
  const loadOptions = resolveWebProviderLoadOptions(context, params);
  const compatible = getLoadedRuntimePluginRegistry({
    env: context.env,
    loadOptions,
    workspaceDir: context.workspaceDir,
    requiredPluginIds: context.loadPluginIds,
  });
  const hasExplicitEmptyScope =
    context.onlyPluginIds !== undefined && context.onlyPluginIds.length === 0;
  // Candidate coverage is checked before reuse. An empty compatible registry is
  // authoritative only for an explicit empty scope; otherwise load below.
  if (compatible) {
    const providers = deps.mapRegistryProviders({
      registry: compatible,
      onlyPluginIds: context.onlyPluginIds,
    });
    if (providers.length > 0 || hasExplicitEmptyScope) {
      return providers;
    }
  }
  if (isPluginRegistryLoadInFlight(loadOptions)) {
    return [];
  }
  if (hasExplicitEmptyScope) {
    return [];
  }
  if (
    params.activate !== true &&
    context.loadPluginIds &&
    deps.resolveBundledRuntimeArtifactProviders
  ) {
    const bundledArtifactProviders = deps.resolveBundledRuntimeArtifactProviders({
      config: context.config,
      workspaceDir: context.workspaceDir,
      env: context.env,
      onlyPluginIds: context.loadPluginIds,
      ...(context.manifestRecords ? { manifestRecords: context.manifestRecords } : {}),
    });
    if (bundledArtifactProviders) {
      return bundledArtifactProviders;
    }
  }
  const registry = loadOpenClawPlugins(loadOptions);
  return deps.mapRegistryProviders({
    registry,
    onlyPluginIds: context.onlyPluginIds,
  });
}
