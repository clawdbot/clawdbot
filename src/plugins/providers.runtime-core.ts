// Runtime boundary for resolving provider plugins from metadata and config.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveBundledCompatActivationInputs,
  withActivatedPluginIds,
} from "./activation-context.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { hasExplicitPluginIdScope } from "./plugin-scope.js";
import { resolveProviderConfigApiOwnerHint } from "./provider-config-owner.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveDiscoverableProviderOwnerPluginIds,
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveOwningPluginIdsForModelRefs,
  resolveOwningPluginIdsForProviderRef,
} from "./providers.js";
import {
  retainPluginRegistryResources,
  type PluginRegistryHandle,
  type PluginRegistryResourceClaim,
} from "./registry-resources.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

export type PluginProvidersHandle = PluginRegistryResourceClaim & { providers: ProviderPlugin[] };

export function createProviderRegistryResolver(dependencies: {
  loadOpenClawPlugins: (options: PluginLoadOptions) => PluginRegistryHandle;
  resolveRuntimePluginRegistry: (options?: PluginLoadOptions) => PluginRegistryHandle | undefined;
  isPluginRegistryLoadInFlight: (options?: PluginLoadOptions) => boolean;
}) {
  const { loadOpenClawPlugins, resolveRuntimePluginRegistry, isPluginRegistryLoadInFlight } =
    dependencies;

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
    const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
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
    const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
    const snapshot =
      params.pluginMetadataSnapshot ??
      resolvePluginMetadataSnapshot({
        config: params.config ?? {},
        workspaceDir,
        env,
      });
    return { env, workspaceDir, snapshot };
  }

  function resolveSetupProviderPluginLoadOptions(
    params: Parameters<typeof acquirePluginProvidersCore>[0],
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
    return buildPluginRuntimeLoadOptionsFromValues(
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
  }

  function resolveRuntimeProviderPluginLoadOptions(
    params: Parameters<typeof acquirePluginProvidersCore>[0],
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
    const activation = resolveBundledCompatActivationInputs({
      rawConfig: requestConfig,
      env: base.env,
      workspaceDir: base.workspaceDir,
      applyAutoEnable: params.applyAutoEnable ?? true,
      discovery: snapshot.discovery,
      manifestRegistry: snapshot.manifestRegistry,
      onlyPluginIds: runtimeRequestedPluginIds,
      resolveBundledPluginIds: resolveBundledProviderCompatPluginIds,
      activation: "defaults",
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
    return buildPluginRuntimeLoadOptionsFromValues(
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
  }

  function isPluginProvidersLoadInFlight(
    params: Parameters<typeof acquirePluginProvidersCore>[0],
  ): boolean {
    const { env, workspaceDir, snapshot } = resolveProviderMetadataLookup(params);
    const base = resolvePluginProviderLoadBase({ ...params, workspaceDir, env }, snapshot);
    const loadOptions =
      params.mode === "setup"
        ? resolveSetupProviderPluginLoadOptions(params, base, snapshot)
        : resolveRuntimeProviderPluginLoadOptions(params, base, snapshot);
    if (!loadOptions) {
      return false;
    }
    return isPluginRegistryLoadInFlight(loadOptions);
  }

  function acquirePluginProvidersCore(params: {
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
  }): PluginProvidersHandle & { registry?: PluginRegistry } {
    const empty = () => ({ providers: [], release() {} });
    const { env, workspaceDir, snapshot } = resolveProviderMetadataLookup(params);
    const base = resolvePluginProviderLoadBase({ ...params, workspaceDir, env }, snapshot);
    if (params.mode === "setup") {
      const loadOptions = resolveSetupProviderPluginLoadOptions(params, base, snapshot);
      if (!loadOptions) {
        return empty();
      }
      if (params.skipIfLoadInFlight && isPluginRegistryLoadInFlight(loadOptions)) {
        return empty();
      }
      const handle = loadOpenClawPlugins(loadOptions);
      try {
        return {
          ...handle,
          providers: handle.registry.providers.map((entry) =>
            Object.assign({}, entry.provider, { pluginId: entry.pluginId }),
          ),
        };
      } catch (error) {
        handle.release();
        throw error;
      }
    }
    const loadOptions = resolveRuntimeProviderPluginLoadOptions(params, base, snapshot);
    const generationRegistry = getPluginRuntimeGenerationRegistry();
    if (
      !generationRegistry &&
      params.skipIfLoadInFlight &&
      isPluginRegistryLoadInFlight(loadOptions)
    ) {
      return empty();
    }
    const onlyPluginIds = loadOptions.onlyPluginIds;
    // Prepared discovery must retain its exact runtime artifacts, including an empty selection.
    const borrowedRegistry =
      onlyPluginIds?.length === 0
        ? undefined
        : (generationRegistry ??
          getLoadedRuntimePluginRegistry({
            env: base.env,
            loadOptions,
            workspaceDir: base.workspaceDir,
            requiredPluginIds: onlyPluginIds,
          }));
    const handle = borrowedRegistry
      ? { registry: borrowedRegistry, ...retainPluginRegistryResources(borrowedRegistry) }
      : onlyPluginIds?.length === 0
        ? undefined
        : resolveRuntimePluginRegistry(loadOptions);
    if (!handle) {
      return empty();
    }

    try {
      return {
        ...handle,
        providers: handle.registry.providers
          .filter((entry) => !onlyPluginIds || onlyPluginIds.includes(entry.pluginId))
          .map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId })),
      };
    } catch (error) {
      handle.release();
      throw error;
    }
  }

  return { isPluginProvidersLoadInFlight, acquirePluginProvidersCore };
}
