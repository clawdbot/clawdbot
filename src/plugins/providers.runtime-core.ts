// Runtime boundary for resolving provider plugins from metadata and config.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveBundledCompatActivationInputs,
  withActivatedPluginIds,
} from "./activation-context.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import {
  createRuntimePluginManifestLookup,
  getLoadedRuntimePluginRegistry,
  registryContainsRuntimePluginIds,
} from "./active-runtime-registry.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import { resolvePluginRegistrationConfigKey } from "./loader-registration-config.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { hasCompletedPluginRuntimeRegistration } from "./plugin-runtime-artifact-selection.js";
import { hasExplicitPluginIdScope } from "./plugin-scope.js";
import { resolveProviderConfigApiOwnerHint } from "./provider-config-owner.js";
import {
  buildDeclaredProviderOwnerIndex,
  matchesDeclaredProviderOwner,
  type DeclaredProviderOwnerIndex,
} from "./provider-owner-index.js";
import {
  matchesProviderPluginRef,
  resolveProviderRuntimeWorkspaceDir,
} from "./provider-registry-shared.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveDiscoverableProviderOwnerPluginIds,
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveOwningPluginIdsForModelRefs,
  resolveOwningPluginIdsForProviderRef,
} from "./providers.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-state.js";
import {
  buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger,
  getPluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

export function createProviderRegistryResolver(dependencies: {
  loadOpenClawPlugins: (options: PluginLoadOptions) => PluginRegistry;
  resolveRuntimePluginRegistry: (options?: PluginLoadOptions) => PluginRegistry | undefined;
  isPluginRegistryLoadInFlight: (options?: PluginLoadOptions) => boolean;
}) {
  const { loadOpenClawPlugins, resolveRuntimePluginRegistry, isPluginRegistryLoadInFlight } =
    dependencies;
  type ProviderResolutionInputs = Parameters<typeof resolvePluginProviderRegistryCore>[0] & {
    env: NodeJS.ProcessEnv;
  };

  function resolveProviderOwnerSelection(
    params: {
      provider: string;
      config?: PluginLoadOptions["config"];
      workspaceDir?: string;
      env?: PluginLoadOptions["env"];
    },
    manifestRegistry: NonNullable<PluginLoadOptions["manifestRegistry"]>,
    declaredOwners: DeclaredProviderOwnerIndex,
  ) {
    const apiOwnerHint = resolveProviderConfigApiOwnerHint(params);
    const ownerRef = declaredOwners.has(normalizeProviderId(params.provider))
      ? params.provider
      : (apiOwnerHint ?? params.provider);
    const declaredIds = declaredOwners.get(normalizeProviderId(ownerRef));
    const ownerIds = declaredIds
      ? [...declaredIds]
      : (resolveOwningPluginIdsForProviderRef({
          ...params,
          provider: ownerRef,
          manifestRegistry,
        }) ?? []);
    // Activation helpers still run beside a declared receiver. Their triggers do
    // not confer ownership of another provider's executable hooks.
    const runtimePluginIds = sortUniqueStrings(
      [params.provider, ...(apiOwnerHint ? [apiOwnerHint] : [])].flatMap((provider) =>
        resolveManifestActivationPluginIds({
          ...params,
          trigger: { kind: "provider", provider },
          manifestRecords: manifestRegistry.plugins,
        }),
      ),
    );
    return {
      provider: params.provider,
      ownerPluginIds: ownerIds,
      providerPluginIds: ownerIds.length > 0 ? ownerIds : runtimePluginIds,
      runtimePluginIds,
    };
  }

  function prepareProviderSelection(
    params: ProviderResolutionInputs,
    manifestRegistry?: PluginLoadOptions["manifestRegistry"],
    declaredProviderOwners = buildDeclaredProviderOwnerIndex(manifestRegistry?.plugins ?? []),
  ) {
    const providerOwners = manifestRegistry
      ? (params.providerRefs ?? []).map((provider) =>
          resolveProviderOwnerSelection(
            {
              provider,
              config: params.config,
              workspaceDir: params.workspaceDir,
              env: params.env,
            },
            manifestRegistry,
            declaredProviderOwners,
          ),
        )
      : [];
    const modelOwnedPluginIds =
      manifestRegistry && params.modelRefs?.length
        ? resolveOwningPluginIdsForModelRefs({
            models: params.modelRefs,
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            manifestRegistry,
          })
        : [];
    const explicitOwnerPluginIds = sortUniqueStrings([
      ...providerOwners.flatMap((owner) => [...owner.ownerPluginIds, ...owner.runtimePluginIds]),
      ...modelOwnedPluginIds,
    ]);
    const pluginIds = !manifestRegistry
      ? params.onlyPluginIds
      : hasExplicitPluginIdScope(params.onlyPluginIds) ||
          params.providerRefs?.length ||
          params.modelRefs?.length
        ? sortUniqueStrings([...(params.onlyPluginIds ?? []), ...explicitOwnerPluginIds])
        : undefined;
    return {
      pluginIds,
      workspaceDir: params.workspaceDir,
      manifestRegistry,
      onlyPluginIds: params.onlyPluginIds,
      providerRefs: params.providerRefs,
      projectedPluginIds:
        manifestRegistry && (params.providerRefs?.length || params.modelRefs?.length)
          ? sortUniqueStrings([
              ...providerOwners.flatMap((owner) => owner.providerPluginIds),
              ...modelOwnedPluginIds,
            ])
          : undefined,
      declaredProviderOwners,
      providerRegistrationPluginIds: new Set(
        (manifestRegistry?.plugins ?? [])
          .filter(
            (plugin) => plugin.providers.length > 0 || (plugin.setup?.providers?.length ?? 0) > 0,
          )
          .map((plugin) => plugin.id),
      ),
      runtimeRegistrationPluginIds: new Set(
        providerOwners.flatMap((owner) => owner.runtimePluginIds),
      ),
      unownedProviderRefs: manifestRegistry
        ? providerOwners
            .filter((owner) => owner.ownerPluginIds.length === 0)
            .map((owner) => owner.provider)
        : (params.providerRefs ?? []),
      explicitOwnerPluginIds,
    };
  }

  function prepareProviderLookup(
    params: Parameters<typeof resolvePluginProviderRegistryCore>[0],
    retained = false,
  ) {
    const env = params.env ?? process.env;
    const sourceParams = retained
      ? {
          ...params,
          pluginMetadataSnapshot: getCurrentPluginMetadataSnapshot({ config: params.config, env }),
        }
      : params;
    // Retained metadata owns even an undefined shared-root workspace; only an
    // explicit caller workspace overrides it, never the process-active registry.
    const workspaceDir = resolveProviderRuntimeWorkspaceDir(
      sourceParams,
      retained ? undefined : getActivePluginRegistryWorkspaceDir(),
    );
    const snapshot =
      sourceParams.pluginMetadataSnapshot ??
      (retained || params.registryScope === "loaded"
        ? getCurrentPluginMetadataSnapshot({
            config: params.config,
            env,
            workspaceDir,
            allowWorkspaceScopedSnapshot: true,
          })
        : resolvePluginMetadataSnapshot({ config: params.config ?? {}, env, workspaceDir }));
    const inputs = { ...sourceParams, env, workspaceDir };
    const selection = snapshot
      ? prepareProviderSelection(inputs, snapshot.manifestRegistry, snapshot.declaredProviderOwners)
      : undefined;
    const loadOptions =
      snapshot && selection && !retained
        ? resolveProviderLoadOptions(inputs, selection, snapshot)
        : undefined;
    return { inputs, snapshot, selection, loadOptions };
  }

  function resolveProviderLoadOptions(
    params: ProviderResolutionInputs,
    selection: ReturnType<typeof prepareProviderSelection>,
    snapshot: PluginMetadataRegistryView,
  ): PluginLoadOptions | undefined {
    const sourceConfig = resolvePluginActivationSourceConfig(params);
    const ownerLookup = {
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
      registry: snapshot.index,
      manifestRegistry: snapshot.manifestRegistry,
    };
    const setup = params.mode === "setup";
    const explicitOwnerPluginIds = (
      setup ? resolveDiscoverableProviderOwnerPluginIds : resolveActivatableProviderOwnerPluginIds
    )({ ...ownerLookup, pluginIds: selection.explicitOwnerPluginIds });
    let activation: Pick<
      PluginLoadOptions,
      "config" | "activationSourceConfig" | "autoEnabledReasons"
    >;
    if (setup) {
      selection.pluginIds = sortUniqueStrings([
        ...resolveDiscoveredProviderPluginIds({
          ...ownerLookup,
          onlyPluginIds: selection.pluginIds,
        }),
        ...explicitOwnerPluginIds,
      ]);
      if (selection.pluginIds.length === 0) {
        return undefined;
      }
      const setupConfig = withActivatedPluginIds({
        config: params.config,
        pluginIds: selection.pluginIds,
      });
      activation = {
        config: setupConfig,
        activationSourceConfig: setupConfig,
        autoEnabledReasons: {},
      };
    } else {
      const onlyPluginIds =
        selection.pluginIds !== undefined
          ? sortUniqueStrings([...(params.onlyPluginIds ?? []), ...explicitOwnerPluginIds])
          : undefined;
      activation = resolveBundledCompatActivationInputs({
        rawConfig: withActivatedPluginIds({
          config: params.config,
          pluginIds: explicitOwnerPluginIds,
        }),
        env: params.env,
        workspaceDir: params.workspaceDir,
        applyAutoEnable: params.applyAutoEnable ?? true,
        discovery: snapshot.discovery,
        manifestRegistry: snapshot.manifestRegistry,
        onlyPluginIds,
        resolveBundledPluginIds: resolveBundledProviderCompatPluginIds,
        activation: "defaults",
      });
      const eligiblePluginIds = sortUniqueStrings([
        ...resolveEnabledProviderPluginIds({
          ...ownerLookup,
          config: activation.config,
          onlyPluginIds,
        }),
        ...explicitOwnerPluginIds,
      ]);
      selection.pluginIds = eligiblePluginIds;
      selection.projectedPluginIds = selection.projectedPluginIds?.filter((pluginId) =>
        eligiblePluginIds.includes(pluginId),
      );
    }
    if (params.config !== undefined && sourceConfig !== params.config) {
      // Activation copies runtime config; source validation still owns the original paired inputs.
      activation.activationSourceConfig = withActivatedPluginIds({
        config: sourceConfig,
        pluginIds: setup ? selection.pluginIds : explicitOwnerPluginIds,
      });
    }
    return buildPluginRuntimeLoadOptions(
      {
        ...activation,
        workspaceDir: params.workspaceDir,
        env: params.env,
        logger: createPluginRuntimeLoaderLogger(),
        manifestRegistry: snapshot.manifestRegistry,
        installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index),
      },
      {
        onlyPluginIds: selection.pluginIds,
        pluginSdkResolution: params.pluginSdkResolution,
        cache: params.cache ?? !setup,
        activate: params.activate ?? false,
      },
    );
  }

  function isPluginProvidersLoadInFlight(
    params: Parameters<typeof resolvePluginProvidersCore>[0],
  ): boolean {
    const { loadOptions } = prepareProviderLookup({ ...params, registryScope: undefined });
    return loadOptions !== undefined && isPluginRegistryLoadInFlight(loadOptions);
  }

  function captureProviderRegistrySelection(
    registry: PluginRegistry,
    base: ReturnType<typeof prepareProviderSelection>,
    onlyPluginIds?: readonly string[],
  ) {
    return {
      registry,
      workspaceDir: base.workspaceDir,
      onlyPluginIds,
      isProviderOwnerEligible: (pluginId: string, provider: string) =>
        (!onlyPluginIds || onlyPluginIds.includes(pluginId)) &&
        matchesDeclaredProviderOwner(base.declaredProviderOwners, provider, pluginId),
    };
  }

  function resolveProviderRegistryCandidate(
    registry: PluginRegistry,
    selection: ReturnType<typeof prepareProviderSelection>,
    retained: boolean,
    aliasOwners: readonly string[],
    lookup: ReturnType<typeof createRuntimePluginManifestLookup> | undefined,
  ): ReturnType<typeof captureProviderRegistrySelection> | undefined {
    let onlyPluginIds = selection.pluginIds;
    let projectedPluginIds = selection.projectedPluginIds ?? onlyPluginIds;
    if (selection.unownedProviderRefs.length > 0) {
      onlyPluginIds = sortUniqueStrings([...(onlyPluginIds ?? []), ...aliasOwners]);
      projectedPluginIds = sortUniqueStrings([...(projectedPluginIds ?? []), ...aliasOwners]);
    }
    if (retained) {
      return captureProviderRegistrySelection(registry, selection, projectedPluginIds);
    }
    if (!registryContainsRuntimePluginIds(registry, onlyPluginIds)) {
      return undefined;
    }
    if (lookup) {
      const providerOwners = new Set(registry.providers.map((entry) => entry.pluginId));
      // Manifest-preseeded record.providerIds cannot prove registration. Rows do;
      // activation-only helpers instead need a successful capability-enabled pass.
      for (const id of onlyPluginIds ?? []) {
        const record = lookup(id);
        if (
          !record ||
          (selection.providerRegistrationPluginIds.has(id)
            ? !providerOwners.has(id)
            : selection.runtimeRegistrationPluginIds.has(id) &&
              !hasCompletedPluginRuntimeRegistration(record))
        ) {
          return undefined;
        }
      }
      onlyPluginIds ??= sortUniqueStrings(
        registry.providers.map((entry) => entry.pluginId).filter(lookup),
      );
    }
    // Query refs are alternative names or API-owner hints. Owner completeness
    // above remains mandatory; reuse also needs a provider matching the query.
    return registry.providers.some(
      ({ pluginId, provider }) =>
        (!onlyPluginIds || onlyPluginIds.includes(pluginId)) &&
        (!selection.providerRefs?.length ||
          selection.providerRefs.some((ref) => matchesProviderPluginRef(provider, ref))),
    )
      ? captureProviderRegistrySelection(registry, selection, projectedPluginIds ?? onlyPluginIds)
      : undefined;
  }

  function resolvePluginProviderRegistryCore(params: {
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
    /** Exact preparation or loaded-only inspection without discovery/activation. */
    registryScope?: "exact" | "loaded";
  }): ReturnType<typeof captureProviderRegistrySelection> | undefined {
    if (params.mode === "setup" && params.registryScope === "loaded") {
      return undefined;
    }
    const generationRegistry =
      params.mode === "setup" ? undefined : getPluginRuntimeGenerationRegistry();
    const prepared = prepareProviderLookup(params, Boolean(generationRegistry));
    const { inputs, snapshot } = prepared;
    let { loadOptions } = prepared;
    const { env, workspaceDir } = inputs;
    const registrationConfigKey =
      !generationRegistry && params.config !== undefined
        ? resolvePluginRegistrationConfigKey(
            loadOptions ?? {
              config: params.config,
              activationSourceConfig: resolvePluginActivationSourceConfig(params),
            },
          )
        : undefined;
    if (params.skipIfLoadInFlight && loadOptions && isPluginRegistryLoadInFlight(loadOptions)) {
      return undefined;
    }
    const prepareRegistry = (
      registry: PluginRegistry,
      selection: ReturnType<typeof prepareProviderSelection>,
    ) => {
      const lookup =
        !generationRegistry && selection.manifestRegistry
          ? createRuntimePluginManifestLookup(registry, selection.manifestRegistry.plugins)
          : undefined;
      const aliasOwners =
        selection.unownedProviderRefs.length > 0
          ? registry.providers
              .filter(
                ({ pluginId, provider }) =>
                  (!selection.onlyPluginIds || selection.onlyPluginIds.includes(pluginId)) &&
                  selection.unownedProviderRefs.some((ref) =>
                    matchesProviderPluginRef(provider, ref),
                  ) &&
                  (!lookup || Boolean(lookup(pluginId))),
              )
              .map((entry) => entry.pluginId)
          : [];
      return {
        lookup,
        aliasOwners:
          !generationRegistry && snapshot && aliasOwners.length > 0
            ? resolveActivatableProviderOwnerPluginIds({
                ...inputs,
                pluginIds: aliasOwners,
                registry: snapshot.index,
                manifestRegistry: snapshot.manifestRegistry,
              })
            : aliasOwners,
      };
    };
    if (generationRegistry || params.mode !== "setup") {
      const request = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
      const requestContext = getPluginRuntimeLoadContext(request);
      const candidates = generationRegistry
        ? [generationRegistry]
        : [
            requestContext && requestContext.workspaceDir === workspaceDir ? request : undefined,
            getLoadedRuntimePluginRegistry({ env, workspaceDir }),
          ];
      for (const registry of candidates) {
        if (!registry) {
          continue;
        }
        const context = getPluginRuntimeLoadContext(registry);
        // Without requested metadata, a loaded-only lookup may use the captured
        // owner only after its discovery/policy scope agrees with the caller.
        if (
          !snapshot &&
          !generationRegistry &&
          context &&
          resolvePluginControlPlaneFingerprint({
            config: params.config ?? context.rawConfig,
            env: params.env ?? context.env,
            workspaceDir,
          }) !== context.controlPlaneFingerprint
        ) {
          continue;
        }
        const selection =
          prepared.selection ??
          prepareProviderSelection(
            inputs,
            context?.manifestRegistry,
            context?.declaredProviderOwners,
          );
        const { lookup, aliasOwners } = prepareRegistry(registry, selection);
        if (
          !generationRegistry &&
          snapshot &&
          aliasOwners.some((id) => !selection.explicitOwnerPluginIds.includes(id))
        ) {
          // Old eligible aliases supply reload hints. Keep the static receiver projection
          // unchanged: refreshed registrations decide which aliases still exist.
          selection.explicitOwnerPluginIds = sortUniqueStrings([
            ...selection.explicitOwnerPluginIds,
            ...aliasOwners,
          ]);
          loadOptions = resolveProviderLoadOptions(inputs, selection, snapshot);
          if (
            params.skipIfLoadInFlight &&
            loadOptions &&
            isPluginRegistryLoadInFlight(loadOptions)
          ) {
            return undefined;
          }
        }
        // Exact preparation may learn aliases here, but its owner load must still run.
        if (
          (!generationRegistry && params.registryScope === "exact") ||
          (context &&
            registrationConfigKey !== undefined &&
            registrationConfigKey !== context.registrationConfigKey)
        ) {
          continue;
        }
        const selected = resolveProviderRegistryCandidate(
          registry,
          selection,
          Boolean(generationRegistry),
          aliasOwners,
          lookup,
        );
        if (selected) {
          return selected;
        }
      }
    }
    if (
      generationRegistry ||
      params.registryScope === "loaded" ||
      !loadOptions ||
      !prepared.selection ||
      loadOptions.onlyPluginIds?.length === 0
    ) {
      return undefined;
    }
    const registry =
      params.mode === "setup" || params.registryScope === "exact"
        ? loadOpenClawPlugins(loadOptions)
        : resolveRuntimePluginRegistry(loadOptions);
    if (!registry) {
      return undefined;
    }
    const projectedPluginIds = prepared.selection.projectedPluginIds ?? loadOptions.onlyPluginIds;
    return captureProviderRegistrySelection(
      registry,
      prepared.selection,
      params.mode !== "setup" && projectedPluginIds
        ? sortUniqueStrings([
            ...projectedPluginIds,
            ...(prepared.selection.unownedProviderRefs.length > 0
              ? prepareRegistry(registry, prepared.selection).aliasOwners
              : []),
          ])
        : undefined,
    );
  }

  function resolvePluginProvidersCore(
    params: Parameters<typeof resolvePluginProviderRegistryCore>[0],
  ): ProviderPlugin[] {
    const resolved = resolvePluginProviderRegistryCore(params);
    if (!resolved) {
      return [];
    }
    const { registry, onlyPluginIds } = resolved;
    return registry.providers
      .filter((entry) => !onlyPluginIds || onlyPluginIds.includes(entry.pluginId))
      .map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId }));
  }

  return {
    isPluginProvidersLoadInFlight,
    resolvePluginProviderRegistryCore,
    resolvePluginProvidersCore,
  };
}
