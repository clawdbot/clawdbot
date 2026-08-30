// Runtime boundary for resolving provider plugins from metadata and config.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolvePluginActivationInputs, withActivatedPluginIds } from "./activation-context.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import {
  getLoadedRuntimePluginRegistry,
  registryMatchesManifestPluginIds,
} from "./active-runtime-registry.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import {
  getRuntimePluginRegistryForLoadOptions,
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  type PluginLoadOptions,
} from "./loader.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { hasExplicitPluginIdScope } from "./plugin-scope.js";
import { resolveProviderConfigApiOwnerHint } from "./provider-config-owner.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveDiscoverableProviderOwnerPluginIds,
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveOwningPluginIdsForModelRefs,
  resolveOwningPluginIdsForProviderRef,
} from "./providers.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

function resolveExplicitProviderOwnerPluginIds(
  params: {
    providerRefs: readonly string[];
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
  },
  snapshot: PluginMetadataRegistryView,
): string[] {
  return sortUniqueStrings(
    params.providerRefs.flatMap((provider) => {
      const plannedPluginIds = resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        manifestRecords: snapshot.manifestRegistry.plugins,
      });
      if (plannedPluginIds.length > 0) {
        return plannedPluginIds;
      }
      const apiOwnerHint = resolveProviderConfigApiOwnerHint({
        provider,
        config: params.config,
      });
      if (apiOwnerHint) {
        const apiOwnerPluginIds = resolveManifestActivationPluginIds({
          trigger: {
            kind: "provider",
            provider: apiOwnerHint,
          },
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          manifestRecords: snapshot.manifestRegistry.plugins,
        });
        if (apiOwnerPluginIds.length > 0) {
          return apiOwnerPluginIds;
        }
      }
      return (
        resolveOwningPluginIdsForProviderRef({
          provider,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          manifestRegistry: snapshot.manifestRegistry,
        }) ?? []
      );
    }),
  );
}

function mergeExplicitOwnerPluginIds(
  providerPluginIds: readonly string[],
  explicitOwnerPluginIds: readonly string[],
): string[] {
  if (explicitOwnerPluginIds.length === 0) {
    return [...providerPluginIds];
  }
  return sortUniqueStrings([...providerPluginIds, ...explicitOwnerPluginIds]);
}

function resolvePluginProviderLoadBase(
  params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: string[];
    providerRefs?: readonly string[];
    modelRefs?: readonly string[];
  },
  snapshot: PluginMetadataRegistryView,
) {
  const env = params.env ?? process.env;
  const workspaceDir = snapshot.workspaceDir;
  const providerOwnedPluginIds = params.providerRefs?.length
    ? resolveExplicitProviderOwnerPluginIds(
        {
          providerRefs: params.providerRefs,
          config: params.config,
          workspaceDir,
          env,
        },
        snapshot,
      )
    : [];
  const modelOwnedPluginIds = params.modelRefs?.length
    ? resolveOwningPluginIdsForModelRefs({
        models: params.modelRefs,
        config: params.config,
        workspaceDir,
        env,
        manifestRegistry: snapshot.manifestRegistry,
      })
    : [];
  const requestedPluginIds =
    hasExplicitPluginIdScope(params.onlyPluginIds) ||
    params.providerRefs?.length ||
    params.modelRefs?.length ||
    providerOwnedPluginIds.length > 0 ||
    modelOwnedPluginIds.length > 0
      ? sortUniqueStrings([
          ...(params.onlyPluginIds ?? []),
          ...providerOwnedPluginIds,
          ...modelOwnedPluginIds,
        ])
      : undefined;
  const explicitOwnerPluginIds = sortUniqueStrings([
    ...providerOwnedPluginIds,
    ...modelOwnedPluginIds,
  ]);
  return {
    env,
    workspaceDir,
    requestedPluginIds,
    explicitOwnerPluginIds,
    rawConfig: params.config,
  };
}

function resolveProviderMetadataLookup(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}) {
  const env = params.env ?? process.env;
  const snapshot =
    params.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: params.config ?? {},
      workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDir(),
      env,
    });
  return { env, workspaceDir: snapshot.workspaceDir, snapshot };
}

function listProviderPluginsFromPreparedRegistry(
  registry: PluginRegistry,
  snapshot: PluginMetadataRegistryView,
  pluginIds: readonly string[] | undefined,
): ProviderPlugin[] {
  const allowed = pluginIds ? new Set(pluginIds) : undefined;
  return registry.providers
    .filter(
      (entry) =>
        (!allowed || allowed.has(entry.pluginId)) &&
        registryMatchesManifestPluginIds(registry, snapshot.manifestRegistry.plugins, [
          entry.pluginId,
        ]),
    )
    .map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId }));
}

function resolveSetupProviderPluginLoadState(
  params: Parameters<typeof resolvePluginProvidersCore>[0],
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
  snapshot: PluginMetadataRegistryView,
) {
  const providerPluginIds = resolveDiscoveredProviderPluginIds({
    config: params.config,
    workspaceDir: base.workspaceDir,
    env: base.env,
    onlyPluginIds: base.requestedPluginIds,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
    registry: snapshot.index,
    manifestRegistry: snapshot.manifestRegistry,
  });
  const explicitOwnerPluginIds = resolveDiscoverableProviderOwnerPluginIds({
    pluginIds: base.explicitOwnerPluginIds,
    config: params.config,
    workspaceDir: base.workspaceDir,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
    registry: snapshot.index,
    manifestRegistry: snapshot.manifestRegistry,
  });
  const setupPluginIds = mergeExplicitOwnerPluginIds(providerPluginIds, explicitOwnerPluginIds);
  if (setupPluginIds.length === 0) {
    return undefined;
  }
  const setupConfig = withActivatedPluginIds({
    config: base.rawConfig,
    pluginIds: setupPluginIds,
  });
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config: setupConfig,
      activationSourceConfig: setupConfig,
      autoEnabledReasons: {},
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
      manifestRegistry: snapshot.manifestRegistry,
      installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index),
    },
    {
      onlyPluginIds: setupPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
    },
  );
  return { loadOptions };
}

function resolveRuntimeProviderPluginLoadState(
  params: Parameters<typeof resolvePluginProvidersCore>[0],
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
  snapshot: PluginMetadataRegistryView,
) {
  const explicitOwnerPluginIds = resolveActivatableProviderOwnerPluginIds({
    pluginIds: base.explicitOwnerPluginIds,
    config: base.rawConfig,
    workspaceDir: base.workspaceDir,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
    registry: snapshot.index,
    manifestRegistry: snapshot.manifestRegistry,
  });
  const runtimeRequestedPluginIds =
    base.requestedPluginIds !== undefined
      ? sortUniqueStrings([...(params.onlyPluginIds ?? []), ...explicitOwnerPluginIds])
      : undefined;
  const requestConfig = withActivatedPluginIds({
    config: base.rawConfig,
    pluginIds: explicitOwnerPluginIds,
  });
  const activation = resolvePluginActivationInputs({
    rawConfig: requestConfig,
    env: base.env,
    workspaceDir: base.workspaceDir,
    applyAutoEnable: params.applyAutoEnable ?? true,
    discovery: snapshot.discovery,
    manifestRegistry: snapshot.manifestRegistry,
  });
  const providerPluginIds = mergeExplicitOwnerPluginIds(
    resolveEnabledProviderPluginIds({
      config: activation.config,
      workspaceDir: base.workspaceDir,
      env: base.env,
      onlyPluginIds: runtimeRequestedPluginIds,
      registry: snapshot.index,
      manifestRegistry: snapshot.manifestRegistry,
    }),
    explicitOwnerPluginIds,
  );
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config: activation.config,
      activationSourceConfig: activation.activationSourceConfig,
      autoEnabledReasons: activation.autoEnabledReasons,
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
      manifestRegistry: snapshot.manifestRegistry,
      installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index),
    },
    {
      onlyPluginIds: providerPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? true,
      activate: params.activate ?? false,
    },
  );
  return { loadOptions };
}

export function isPluginProvidersLoadInFlight(
  params: Parameters<typeof resolvePluginProvidersCore>[0],
): boolean {
  const { env, workspaceDir, snapshot } = resolveProviderMetadataLookup(params);
  const base = resolvePluginProviderLoadBase({ ...params, workspaceDir, env }, snapshot);
  const loadState =
    params.mode === "setup"
      ? resolveSetupProviderPluginLoadState(params, base, snapshot)
      : resolveRuntimeProviderPluginLoadState(params, base, snapshot);
  if (!loadState) {
    return false;
  }
  return isPluginRegistryLoadInFlight(loadState.loadOptions);
}

export function resolvePluginProvidersCore(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  /** @deprecated Ignored; tests must provide explicit plugin config. Remove in the next major release. */
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  applyAutoEnable?: boolean;
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
  mode?: "runtime" | "setup";
  includeUntrustedWorkspacePlugins?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
  skipIfLoadInFlight?: boolean;
}): ProviderPlugin[] {
  const { env, workspaceDir, snapshot } = resolveProviderMetadataLookup(params);
  const base = resolvePluginProviderLoadBase({ ...params, workspaceDir, env }, snapshot);
  if (params.mode === "setup") {
    const loadState = resolveSetupProviderPluginLoadState(params, base, snapshot);
    if (!loadState) {
      return [];
    }
    if (params.skipIfLoadInFlight && isPluginRegistryLoadInFlight(loadState.loadOptions)) {
      return [];
    }
    const registry = loadOpenClawPlugins(loadState.loadOptions);
    return listProviderPluginsFromPreparedRegistry(
      registry,
      snapshot,
      loadState.loadOptions.onlyPluginIds,
    );
  }
  const loadState = resolveRuntimeProviderPluginLoadState(params, base, snapshot);
  if (params.skipIfLoadInFlight && isPluginRegistryLoadInFlight(loadState.loadOptions)) {
    return [];
  }
  if (loadState.loadOptions.onlyPluginIds?.length === 0) {
    return [];
  }
  const activeRegistry = getLoadedRuntimePluginRegistry({
    env: base.env,
    loadOptions: loadState.loadOptions,
    workspaceDir: base.workspaceDir,
    requiredPluginIds: loadState.loadOptions.onlyPluginIds,
  });
  const registry =
    activeRegistry &&
    registryMatchesManifestPluginIds(
      activeRegistry,
      snapshot.manifestRegistry.plugins,
      loadState.loadOptions.onlyPluginIds ??
        activeRegistry.providers.map((entry) => entry.pluginId),
    )
      ? activeRegistry
      : getRuntimePluginRegistryForLoadOptions(loadState.loadOptions);
  if (!registry) {
    return [];
  }

  return listProviderPluginsFromPreparedRegistry(
    registry,
    snapshot,
    loadState.loadOptions.onlyPluginIds,
  );
}
