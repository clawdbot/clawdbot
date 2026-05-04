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

type RuntimeRegistryWebProviderResolution<TEntry> = {
  providers: TEntry[];
  shouldReturn: boolean;
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

function resolveRuntimeRegistryWebProviders<TEntry>(params: {
  hasExplicitEmptyScope: boolean;
  mapRegistryProviders: ResolveWebProviderRuntimeDeps<TEntry>["mapRegistryProviders"];
  onlyPluginIds?: readonly string[];
  registry: PluginRegistry | undefined;
}): RuntimeRegistryWebProviderResolution<TEntry> | undefined {
  if (!params.registry) {
    return undefined;
  }
  const providers = params.mapRegistryProviders({
    registry: params.registry,
    onlyPluginIds: params.onlyPluginIds,
  });
  return {
    providers,
    shouldReturn: providers.length > 0 || params.hasExplicitEmptyScope,
  };
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
  const scopedPluginIds = context.onlyPluginIds;
  const hasExplicitEmptyScope = scopedPluginIds !== undefined && scopedPluginIds.length === 0;
  const compatibleProviders = resolveRuntimeRegistryWebProviders({
    hasExplicitEmptyScope,
    mapRegistryProviders: deps.mapRegistryProviders,
    onlyPluginIds: context.onlyPluginIds,
    registry: compatible,
  });
  if (compatibleProviders?.shouldReturn) {
    return compatibleProviders.providers;
  }
  if (compatibleProviders) {
    // The active gateway plugin registry may be otherwise compatible with this
    // config while contributing zero web providers (for example when channels,
    // memory, harnesses, and sidecars are loaded but Brave/web providers are
    // not). Do not treat that empty active registry as authoritative: fall
    // through to a scoped provider load below so first-class assistant tools
    // still see the configured provider.
  }
  if (isPluginRegistryLoadInFlight(loadOptions)) {
    return [];
  }
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
  const hasExplicitEmptyScope =
    params.onlyPluginIds !== undefined && params.onlyPluginIds.length === 0;
  const runtimeProviders = resolveRuntimeRegistryWebProviders({
    hasExplicitEmptyScope,
    mapRegistryProviders: deps.mapRegistryProviders,
    onlyPluginIds: params.onlyPluginIds,
    registry: runtimeRegistry,
  });
  if (runtimeProviders?.shouldReturn) {
    return runtimeProviders.providers;
  }
  return resolvePluginWebProviders(params, deps);
}
