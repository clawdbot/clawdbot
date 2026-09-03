import { performance } from "node:perf_hooks";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
} from "../plugins/prepared-message-tool-catalog.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import { resolvePreparedProviderStaticConfigs } from "../plugins/provider-discovery.js";
import { resolveLoadedProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { resolveAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import {
  discoverAuthStorageFacts,
  discoverModelsFromCapturedSources,
} from "./agent-model-discovery.js";
import { withAgentRosterFactsBatch } from "./agent-scope-config.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import {
  createBundledStaticCatalogModelResolver,
  loadBundledProviderStaticCatalogContextModels,
} from "./embedded-agent-runner/model.static-catalog.js";
import { createStaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import {
  buildConfiguredModelCatalog,
  parseConfiguredModelVisibilityEntries,
} from "./model-selection-shared.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import { modelCatalogLogicalKey } from "./openai-model-routes.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";
import { loadPreparedModelRuntimeAuthStore } from "./prepared-model-runtime.auth-store.js";
import type {
  PreparedModelRuntimeAgentBaseFacts,
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import { prepareConfiguredRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { completeConfiguredRuntimeModels } from "./prepared-model-runtime.configured-completion.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectPreparedModelRuntimeProviderIds,
  prepareConfiguredRuntimeModels,
  prepareRuntimeCapabilityModels,
  toStaticCatalogEntry,
} from "./prepared-model-runtime.configured.js";
import {
  captureModelsJsonContents,
  groupConfiguredRegistrySources,
} from "./prepared-model-runtime.facts-support.js";
import {
  prepareWorkspacePluginRegistries,
  type PreparedInboundRegistryLoader,
} from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { createPreparedPluginGeneration } from "./prepared-model-runtime.plugin-generation.js";
import {
  listPreparedSyntheticAuthProviderRefs,
  resolveManifestNativeAuthRuntime,
  resolveManifestNativeHarness,
  resolvePreparedSyntheticAuth,
  scopeSyntheticAuthProviderRefs,
} from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
export { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts-support.js";

const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;

function collectPreparedAuthProfileProviderIds(input: PreparedModelRuntimeInput): string[] {
  return [
    ...new Set(
      Object.values(loadPreparedModelRuntimeAuthStore(input).profiles)
        .map((profile) => normalizeProviderId(profile.provider))
        .filter(Boolean),
    ),
  ];
}

function prepareAgentFacts(
  input: PreparedModelRuntimeInput,
  ambientAuth: ReturnType<typeof resolveAmbientAgentCredentialsForDiscovery>,
  additionalProviderIds: readonly string[] = [],
): PreparedModelRuntimeAgentBaseFacts {
  const env = input.env ?? process.env;
  const preparedStore = loadPreparedModelRuntimeAuthStore(input);
  const authFacts = discoverAuthStorageFacts(input.agentDir, {
    config: input.config,
    // Prepared owners consume only the already-published runtime auth generation. External CLI
    // hydration belongs to startup/control-plane and turn-time producers, never rebuilds.
    readOnly: true,
    ambientCredentials: ambientAuth,
    preparedStore,
    ...(input.skipCredentials ? { skipCredentials: true } : {}),
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  });
  const credentials = authFacts.credentials;
  const templateAuthStorage = authFacts.authStorage;
  const rawConfiguredModelRefs = collectPreparedModelRuntimeConfiguredRefs(
    input.config,
    input.agentId,
  );
  return {
    input,
    env,
    authStore: authFacts.store,
    templateAuthStorage,
    credentials,
    providerAuth: authFacts.providerAuth,
    // Keep order and case-distinct refs: registry lookup remains exact-case even
    // where static/dynamic completion deduplicates case-insensitive merge keys.
    configuredModelRefs: rawConfiguredModelRefs.flatMap(({ value }) => {
      const ref = parseModelCatalogRef(value);
      return ref ? [ref] : [];
    }),
    // Include credential providers so their curated rows are available before live discovery.
    providerIds: [
      ...new Set([
        ...collectPreparedModelRuntimeProviderIds(
          input.config,
          credentials,
          rawConfiguredModelRefs,
          input.agentId,
        ),
        ...parseConfiguredModelVisibilityEntries({
          cfg: input.config,
          agentId: input.agentId,
        }).providerWildcards,
        ...additionalProviderIds.map(normalizeProviderId).filter(Boolean),
      ]),
    ].toSorted((left, right) => left.localeCompare(right)),
  };
}

export async function prepareWorkspaceBuildGroup(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  options: {
    providerDiscoveryProviderIds?: readonly string[];
    preferBuiltPluginArtifacts?: boolean;
    getConfiguredHarnessRuntimes?: () => readonly string[];
    basePluginIds?: readonly string[];
  } = {},
  loadInboundPluginRegistry?: PreparedInboundRegistryLoader,
  reusablePluginGeneration?: PreparedModelRuntimePluginGeneration,
  preparedPluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): Promise<{
  agentFacts: PreparedModelRuntimeAgentFacts[];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  buildStats: Pick<
    PreparedModelRuntimeBuildStats,
    | "runtimePluginMs"
    | "pluginMetadataMs"
    | "staticProviderCatalogMs"
    | "ambientCredentialsMs"
    | "agentFactsMs"
    | "configuredProjectionMs"
  >;
}> {
  const input = inputs[0];
  if (!input) {
    throw new Error("prepared model runtime workspace group is empty");
  }
  const env = input.env ?? process.env;
  const pluginMetadataStartedAt = performance.now();
  const pluginMetadataSnapshot =
    preparedPluginMetadataSnapshot ??
    reusablePluginGeneration?.pluginMetadataSnapshot ??
    prepareOwnedPluginLoadContext(input, env, undefined);
  const pluginMetadataMs = reusablePluginGeneration
    ? 0
    : performance.now() - pluginMetadataStartedAt;
  const manifestSyntheticAuth = resolveManifestNativeHarness({
    config: input.config,
    env,
    metadataSnapshot: pluginMetadataSnapshot,
    workspaceDir: input.workspaceDir,
    resolveRuntimes: catalogMode === "live",
  });
  const manifestSyntheticAuthProviderIds = manifestSyntheticAuth.providerIds;
  const manifestSyntheticAuthProviderRefs = manifestSyntheticAuth.providerRefs;
  const nativeHarnessRuntimes = manifestSyntheticAuth.runtimes;
  const configuredHarnessRuntimes = () => [
    ...(options.getConfiguredHarnessRuntimes?.() ?? []),
    ...nativeHarnessRuntimes,
  ];
  const runtimePluginStartedAt = performance.now();
  const preferBuiltPluginArtifacts =
    reusablePluginGeneration?.preferBuiltPluginArtifacts ??
    options.preferBuiltPluginArtifacts === true;
  const { inboundPluginRegistry, runtimePluginRegistry } = prepareWorkspacePluginRegistries(
    input,
    pluginMetadataSnapshot,
    loadInboundPluginRegistry,
    preferBuiltPluginArtifacts,
    reusablePluginGeneration,
    configuredHarnessRuntimes,
    options.basePluginIds,
  );
  const reuseRuntimeFacts =
    reusablePluginGeneration && runtimePluginRegistry === reusablePluginGeneration.pluginRegistry;
  const runtimePluginMs = performance.now() - runtimePluginStartedAt;
  prepareOwnedPluginLoadContext(
    input,
    env,
    runtimePluginRegistry,
    pluginMetadataSnapshot,
    preferBuiltPluginArtifacts,
  );
  const prepare = async () => {
    const matchesStaticModelId = createStaticModelIdMatcher({
      manifestPlugins: pluginMetadataSnapshot,
    });
    const mediaCapabilityProviders = reuseRuntimeFacts
      ? reusablePluginGeneration.mediaCapabilityProviders
      : input.readOnly || !runtimePluginRegistry
        ? undefined
        : prepareMediaCapabilityProviders({
            cfg: input.config,
            pluginMetadataSnapshot,
            registry: runtimePluginRegistry,
          });
    const messageToolCatalog = reuseRuntimeFacts
      ? reusablePluginGeneration.messageToolCatalog
      : runtimePluginRegistry
        ? getPreparedMessageToolCatalogForRegistry(runtimePluginRegistry)
        : catalogMode === "live"
          ? getPreparedMessageToolCatalog()
          : undefined;
    const resolveManifestStaticCatalogModel = createBundledStaticCatalogModelResolver({
      cfg: input.config,
      env,
      includeRuntimeDiscovery: true,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const configuredManifestModels = new Map<string, ProviderRuntimeModel | undefined>();
    const resolveConfiguredManifestModel = (lookup: { provider: string; modelId: string }) => {
      const key = `${normalizeProviderId(lookup.provider)}\0${lookup.modelId.trim().toLowerCase()}`;
      if (configuredManifestModels.has(key)) {
        return configuredManifestModels.get(key);
      }
      const model = resolveManifestStaticCatalogModel(lookup);
      configuredManifestModels.set(key, model);
      return model;
    };
    const configuredProviderIds = [
      ...new Set([
        ...inputs.flatMap((candidate) =>
          withAgentRosterFactsBatch(candidate.config, () => [
            ...collectPreparedModelRuntimeProviderIds(
              candidate.config,
              {},
              collectPreparedModelRuntimeConfiguredRefs(candidate.config, candidate.agentId),
              candidate.agentId,
            ),
            ...collectPreparedAuthProfileProviderIds(candidate),
            ...parseConfiguredModelVisibilityEntries({
              cfg: candidate.config,
              agentId: candidate.agentId,
            }).providerWildcards,
          ]),
        ),
        ...manifestSyntheticAuthProviderIds,
        ...(options.providerDiscoveryProviderIds ?? []).map(normalizeProviderId).filter(Boolean),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
    const staticProviderCatalogStartedAt = performance.now();
    let preparedStaticProviderCatalog = reusablePluginGeneration
      ? reusablePluginGeneration.preparedStaticProviderCatalog
      : catalogMode === "static"
        ? await prepareImplicitProviderStaticCatalog({
            config: input.config,
            env,
            pluginMetadataSnapshot,
            providerDiscoveryProviderIds: configuredProviderIds,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          })
        : undefined;
    if (
      catalogMode === "static" &&
      reusablePluginGeneration &&
      !reuseRuntimeFacts &&
      runtimePluginRegistry?.providers.length
    ) {
      // Selected owners may supply synthetic auth absent from startup's configured
      // providers. Carry those exact handles through refresh without rediscovery.
      preparedStaticProviderCatalog = Object.freeze({
        entries: preparedStaticProviderCatalog?.entries ?? [],
        providers: Object.freeze([
          ...new Map([
            ...(preparedStaticProviderCatalog?.providers ?? []).map(
              (provider) => [provider.id, provider] as const,
            ),
            ...runtimePluginRegistry.providers.map(
              ({ provider }) => [provider.id, provider] as const,
            ),
          ]).values(),
        ]),
      });
    }
    const staticProviderCatalogMs = reusablePluginGeneration
      ? 0
      : performance.now() - staticProviderCatalogStartedAt;
    const preparedSyntheticAuthProviders = preparedStaticProviderCatalog?.providers ?? [];
    const preparedSyntheticAuthProviderRefs = listPreparedSyntheticAuthProviderRefs(
      preparedSyntheticAuthProviders,
    );
    // Static Gateway publication consumes discovery entrypoints; the run owns activation.
    const ambientCredentialsStartedAt = performance.now();
    const ambientAuth = resolveAmbientAgentCredentialsForDiscovery({
      config: input.config,
      env,
      canonicalProvider: (provider) =>
        resolveProviderIdForAuth(provider, {
          config: input.config,
          env,
          metadataSnapshot: pluginMetadataSnapshot,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        }),
      nativeRuntime: (provider) =>
        resolveManifestNativeAuthRuntime({
          provider,
          metadataSnapshot: pluginMetadataSnapshot,
        }),
      authoritativeSyntheticAuthProviderRefs: pluginMetadataSnapshot.owners.cliBackends.keys(),
      syntheticAuthProviderRefs:
        catalogMode === "static"
          ? [
              ...new Set([
                ...preparedSyntheticAuthProviderRefs,
                ...manifestSyntheticAuthProviderRefs,
              ]),
            ]
          : scopeSyntheticAuthProviderRefs(
              resolveRuntimeSyntheticAuthProviderRefs({
                config: input.config,
                env,
                index: pluginMetadataSnapshot.index,
                registryDiagnostics: pluginMetadataSnapshot.registryDiagnostics,
                ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
              }),
              configuredProviderIds,
            ),
      ...(catalogMode === "static"
        ? {
            resolveSyntheticAuth: (provider: string) =>
              resolvePreparedSyntheticAuth({
                config: input.config,
                provider,
                providers: preparedSyntheticAuthProviders,
              }),
          }
        : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const ambientCredentialsMs = performance.now() - ambientCredentialsStartedAt;
    const agentFactsStartedAt = performance.now();
    const agentBaseFacts = inputs.map((candidate) =>
      withAgentRosterFactsBatch(candidate.config, () =>
        prepareAgentFacts(candidate, ambientAuth, [
          ...(options.providerDiscoveryProviderIds ?? []),
          ...manifestSyntheticAuthProviderIds,
        ]),
      ),
    );
    const agentFactsMs = performance.now() - agentFactsStartedAt;
    const configuredProjectionStartedAt = performance.now();
    const providerStaticModels =
      reusablePluginGeneration?.providerStaticModels ??
      (catalogMode === "static"
        ? []
        : await loadBundledProviderStaticCatalogContextModels({
            cfg: input.config,
            env,
            metadataSnapshot: pluginMetadataSnapshot,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          }));
    // Provider definitions are process/config facts. Which refs are admitted remains agent-owned.
    const inlineProviderModels =
      reusablePluginGeneration?.inlineProviderModels ??
      buildInlineProviderModels(input.config.models?.providers ?? {}, {
        providerMetadataOwners: pluginMetadataSnapshot.owners,
      });
    const configuredCatalogEntries =
      reusablePluginGeneration?.configuredCatalogEntries ??
      buildConfiguredModelCatalog({
        cfg: input.config,
        manifestPlugins: pluginMetadataSnapshot,
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      });
    const agentFacts: PreparedModelRuntimeAgentFacts[] = [];
    for (const facts of agentBaseFacts) {
      const configuredRuntimeModels = prepareConfiguredRuntimeModels({
        configuredModelRefs: facts.configuredModelRefs,
        metadataSnapshot: pluginMetadataSnapshot,
        ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
        providerStaticModels,
        matchesStaticModelId,
        resolveStaticCatalogModel: resolveConfiguredManifestModel,
      });
      const runtimeCapabilityModels = prepareRuntimeCapabilityModels({
        config: facts.input.config,
        agentId: facts.input.agentId,
        candidates: [
          ...configuredCatalogEntries,
          ...configuredRuntimeModels.map(({ model, modelId, provider }) => ({
            ...toStaticCatalogEntry(model),
            id: modelId,
            provider,
          })),
        ],
        resolveRuntimeModel: resolveConfiguredManifestModel,
      });
      const configuredEntryKeys = new Set(configuredCatalogEntries.map(modelCatalogLogicalKey));
      for (const configured of configuredRuntimeModels) {
        configuredEntryKeys.add(
          modelCatalogLogicalKey({ provider: configured.provider, id: configured.modelId }),
        );
      }
      const configuredGeneratedCatalogPluginIds = [
        ...new Set(
          facts.configuredModelRefs.flatMap(({ provider, modelId }) => {
            if (configuredEntryKeys.has(modelCatalogLogicalKey({ provider, id: modelId }))) {
              return [];
            }
            const pluginId = resolvePluginModelCatalogOwnerPluginId({
              providerId: provider,
              pluginMetadataSnapshot,
            });
            return pluginId ? [pluginId] : [];
          }),
        ),
      ].toSorted((left, right) => left.localeCompare(right));
      agentFacts.push({
        ...facts,
        configuredRuntimeModels,
        runtimeCapabilityModels,
        configuredGeneratedCatalogPluginIds,
      });
    }
    const configuredProjectionMs = performance.now() - configuredProjectionStartedAt;
    const pluginGeneration = createPreparedPluginGeneration({
      catalogMode,
      configuredCatalogEntries,
      inboundPluginRegistry,
      inlineProviderModels,
      mediaCapabilityProviders,
      messageToolCatalog,
      pluginMetadataSnapshot,
      preparedStaticProviderCatalog,
      nativeHarnessRuntimes,
      providerStaticModels,
      preferBuiltPluginArtifacts,
      reusablePluginGeneration,
      runtimePluginRegistry,
    });
    return {
      agentFacts,
      buildStats: {
        runtimePluginMs,
        pluginMetadataMs,
        staticProviderCatalogMs,
        ambientCredentialsMs,
        agentFactsMs,
        configuredProjectionMs,
      },
      pluginGeneration,
    };
  };
  return await withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: pluginMetadataSnapshot,
      pluginRegistry: runtimePluginRegistry,
    },
    prepare,
  );
}

export function prepareConfiguredRuntimeFactsBatch(params: {
  agentFacts: readonly PreparedModelRuntimeAgentFacts[];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}): {
  catalogs: Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>;
  registryCount: number;
} {
  const catalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
  let registryCount = 0;
  const staticProviderConfigs = resolvePreparedProviderStaticConfigs(
    params.pluginGeneration.preparedStaticProviderCatalog,
  );
  for (const group of groupConfiguredRegistrySources(
    params.agentFacts,
    params.pluginGeneration.preparedStaticProviderCatalog !== undefined,
    loadPersistedPluginModelCatalogsReadOnly,
  )) {
    const representative = group.agentFacts[0];
    if (!representative) {
      continue;
    }
    // Parse identical catalog/auth sources once, then fork request auth.
    const templateModelRegistry = discoverModelsFromCapturedSources(
      representative.templateAuthStorage,
      {
        config: representative.input.config,
        includePluginCatalogs: true,
        modelsJsonContents: group.modelsJsonContents,
        pluginCatalogs: group.pluginCatalogs,
        ...(params.pluginGeneration.preparedStaticProviderCatalog ? { staticProviderConfigs } : {}),
        pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        ...(representative.input.workspaceDir
          ? { workspaceDir: representative.input.workspaceDir }
          : {}),
      },
    );
    registryCount += 1;
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: params.pluginGeneration.pluginRegistry,
      },
      () => {
        for (const facts of group.agentFacts) {
          const { input } = facts;
          const configuredRuntimeModels = params.pluginGeneration.pluginRegistry
            ? completeConfiguredRuntimeModels({
                configuredModelRefs: facts.configuredModelRefs,
                configuredRuntimeModels: facts.configuredRuntimeModels,
                resolveDynamicModel: ({ provider, modelId }) => {
                  const providerConfig =
                    input.config.models?.providers?.[provider] ??
                    findNormalizedProviderValue(input.config.models?.providers, provider);
                  return (
                    resolveLoadedProviderRuntimePlugin({
                      provider,
                      modelId,
                      config: input.config,
                      workspaceDir: input.workspaceDir,
                      env: facts.env,
                    })?.resolveDynamicModel?.({
                      config: input.config,
                      agentDir: input.agentDir,
                      workspaceDir: input.workspaceDir,
                      provider,
                      modelId,
                      modelRegistry: templateModelRegistry,
                      providerConfig,
                    }) ?? undefined
                  );
                },
              })
            : facts.configuredRuntimeModels;
          catalogs.set(
            input,
            prepareConfiguredRuntimeFacts({
              agentFacts: facts,
              workspaceFacts: params.pluginGeneration,
              templateModelRegistry,
              configuredRuntimeModels,
            }),
          );
        }
      },
    );
  }
  return { catalogs, registryCount };
}

export async function prepareAgentCatalogSource(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogMode: PreparedModelRuntimeCatalogMode,
  persist: boolean,
  sourceOptions: {
    authStore?: AuthProfileStore;
    providerDiscoveryProviderIds?: readonly string[];
  } = {},
): Promise<PreparedModelRuntimeCatalogSource> {
  const { env, input, providerIds } = agentFacts;
  const providerOutcomes = new Map<string, ProviderCatalogOutcome>();
  const recordProviderOutcome = (outcome: ProviderCatalogOutcome) => {
    const provider = normalizeProviderId(outcome.provider);
    if (provider) {
      providerOutcomes.set(`${provider}\0${outcome.profileId ?? ""}`, { ...outcome, provider });
    }
  };
  const resultOutcomes = () =>
    [...providerOutcomes.values()].toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        (left.profileId ?? "").localeCompare(right.profileId ?? ""),
    );
  const options = {
    pluginMetadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
    providerDiscoveryProviderIds: sourceOptions.providerDiscoveryProviderIds ?? providerIds,
    ...(pluginGeneration.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: pluginGeneration.preparedStaticProviderCatalog }
      : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
    ...(catalogMode === "static"
      ? {
          providerDiscoveryEntriesOnly: true as const,
        }
      : {
          providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS,
        }),
  };
  const prepareSource = async () => {
    if (!persist) {
      const source = await planOpenClawModelsJsonSource(input.config, input.agentDir, {
        ...options,
        ...(sourceOptions.authStore ? { authStore: sourceOptions.authStore } : {}),
        ...(catalogMode === "live" ? { onProviderCatalogOutcome: recordProviderOutcome } : {}),
      });
      return {
        modelsJsonContents: source.modelsJsonContents,
        pluginCatalogs: source.pluginCatalogs,
        providerOutcomes: resultOutcomes(),
      };
    }
    if (!input.readOnly) {
      await ensureOpenClawModelsJson(input.config, input.agentDir, {
        ...options,
        ...(catalogMode === "live" ? { onProviderCatalogOutcome: recordProviderOutcome } : {}),
      });
    }
    // Capture immediately after the serialized write. Another owner may share this directory and
    // publish a different workspace generation before full-catalog parsing begins.
    return {
      modelsJsonContents: captureModelsJsonContents(input.agentDir),
      pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(input.agentDir),
      providerOutcomes: resultOutcomes(),
    };
  };
  const { pluginMetadataSnapshot: metadataSnapshot, pluginRegistry } = pluginGeneration;
  return pluginRegistry
    ? withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, prepareSource)
    : prepareSource();
}
