import { withActivatedPluginIds } from "./activation-context.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { isPluginRegistryLoadInFlight, loadOpenClawPlugins } from "./loader.js";
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

type WebProviderRuntimeContext = {
  env: NonNullable<PluginLoadOptions["env"]>;
  workspaceDir?: string;
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
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
    params.bundledAllowlistCompat === true;
  const { config, activationSourceConfig, autoEnabledReasons } =
    deps.resolveBundledResolutionConfig({
      ...params,
      workspaceDir,
      env,
    });
  const candidatePluginIds = normalizePluginIdScope(
    deps.resolveCandidatePluginIds({
      config,
      workspaceDir,
      env,
      onlyPluginIds: params.onlyPluginIds,
      origin: params.origin,
    }),
  );
  const onlyPluginIds = shouldFilterProviders ? candidatePluginIds : undefined;
  return {
    activationSourceConfig,
    autoEnabledReasons,
    config,
    env,
    loadPluginIds: candidatePluginIds,
    onlyPluginIds,
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
  if (compatible) {
    return deps.mapRegistryProviders({
      registry: compatible,
      onlyPluginIds: context.onlyPluginIds,
    });
  }
  if (isPluginRegistryLoadInFlight(loadOptions)) {
    return [];
  }
  const scopedPluginIds = context.onlyPluginIds;
  const hasExplicitEmptyScope = scopedPluginIds !== undefined && scopedPluginIds.length === 0;
  if (hasExplicitEmptyScope) {
    return [];
  }
  const registry = loadOpenClawPlugins(loadOptions);
  return deps.mapRegistryProviders({
    registry,
    onlyPluginIds: context.onlyPluginIds,
  });
}

export function resolveRuntimeWebProviders<TEntry>(
  params: Omit<ResolvePluginWebProvidersParams, "activate" | "cache" | "mode">,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): TEntry[] {
  const runtimeRegistry = getLoadedRuntimePluginRegistry({
    env: params.env,
    workspaceDir: params.workspaceDir,
    requiredPluginIds: params.onlyPluginIds,
  });
  if (runtimeRegistry) {
    return deps.mapRegistryProviders({
      registry: runtimeRegistry,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  return resolvePluginWebProviders(params, deps);
}
