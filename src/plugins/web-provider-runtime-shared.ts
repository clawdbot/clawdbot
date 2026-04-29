import { withActivatedPluginIds } from "./activation-context.js";
import {
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { hasExplicitPluginIdScope, normalizePluginIdScope } from "./plugin-scope.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";

export type ResolvePluginWebProvidersParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
};

type ResolveWebProviderRuntimeDeps<TEntry> = {
  resolveBundledResolutionConfig: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
  }) => {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
  };
  resolveCandidatePluginIds: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
  }) => string[] | undefined;
  mapRegistryProviders: (params: {
    registry: PluginRegistry;
    onlyPluginIds?: readonly string[];
  }) => TEntry[];
  resolveBundledPublicArtifactProviders?: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
  }) => TEntry[] | null;
};

function resolveWebProviderLoadOptions<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const { config, activationSourceConfig, autoEnabledReasons } =
    deps.resolveBundledResolutionConfig({
      ...params,
      workspaceDir,
      env,
    });
  const onlyPluginIds = normalizePluginIdScope(
    deps.resolveCandidatePluginIds({
      config,
      workspaceDir,
      env,
      onlyPluginIds: params.onlyPluginIds,
      origin: params.origin,
    }),
  );
  return buildPluginRuntimeLoadOptionsFromValues(
    {
      env,
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      cache: params.cache ?? false,
      activate: params.activate ?? false,
      ...(hasExplicitPluginIdScope(onlyPluginIds) ? { onlyPluginIds } : {}),
    },
  );
}

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
      }) ?? [];
    if (pluginIds.length === 0) {
      return [];
    }
    if (params.activate !== true) {
      const bundledArtifactProviders = deps.resolveBundledPublicArtifactProviders?.({
        config: params.config,
        workspaceDir,
        env,
        bundledAllowlistCompat: params.bundledAllowlistCompat,
        onlyPluginIds: pluginIds,
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
        },
        {
          onlyPluginIds: pluginIds,
          cache: params.cache ?? false,
          activate: params.activate ?? false,
        },
      ),
    );
    return deps.mapRegistryProviders({ registry, onlyPluginIds: pluginIds });
  }

  const loadOptions = resolveWebProviderLoadOptions(params, deps);
  const compatible = resolveCompatibleRuntimePluginRegistry(loadOptions);
  if (compatible) {
    return deps.mapRegistryProviders({
      registry: compatible,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  if (isPluginRegistryLoadInFlight(loadOptions)) {
    return [];
  }
  return deps.mapRegistryProviders({
    registry: loadOpenClawPlugins(loadOptions),
    onlyPluginIds: params.onlyPluginIds,
  });
}

export function resolveRuntimeWebProviders<TEntry>(
  params: Omit<ResolvePluginWebProvidersParams, "activate" | "cache" | "mode">,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): TEntry[] {
  const loadOptions =
    params.config === undefined ? undefined : resolveWebProviderLoadOptions(params, deps);
  const runtimeRegistry = resolveRuntimePluginRegistry(loadOptions);
  if (runtimeRegistry) {
    return deps.mapRegistryProviders({
      registry: runtimeRegistry,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  return resolvePluginWebProviders(params, deps);
}
