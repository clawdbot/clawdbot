import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
} from "../plugins/prepared-message-tool-catalog.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import { prepareAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import {
  discoverAuthStorageFacts,
  discoverModelsFromCapturedSources,
} from "./agent-model-discovery.js";
import { withAgentRosterFactsBatch } from "./agent-scope-config.js";
import {
  getPreparedRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreCredentialsRevision,
} from "./auth-profiles/runtime-snapshots.js";
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
import {
  loadPersistedPluginModelCatalogsReadOnly,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import { loadPreparedModelRuntimeAuthStore } from "./prepared-model-runtime.auth-store.js";
import type {
  PreparedModelRuntimeAgentBaseFacts,
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import {
  modelCatalogEntryKey,
  prepareConfiguredRuntimeFacts,
} from "./prepared-model-runtime.configured-catalog.js";
import { completeConfiguredRuntimeModels } from "./prepared-model-runtime.configured-completion.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectConfiguredProviderIdsNeedingStaticCatalog,
  collectPreparedModelRuntimeProviderIds,
  prepareConfiguredRuntimeModels,
  prepareRuntimeCapabilityModels,
  toStaticCatalogEntry,
} from "./prepared-model-runtime.configured.js";
import {
  prepareWorkspacePluginRegistries,
  type PreparedInboundRegistryLoader,
} from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { createPreparedPluginGeneration } from "./prepared-model-runtime.plugin-generation.js";
import {
  listPreparedSyntheticAuthProviderRefs,
  prepareSyntheticAuth,
  scopeSyntheticAuthProviderRefs,
} from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;
type PreparedConfiguredRegistryGroup = {
  agentFacts: PreparedModelRuntimeAgentFacts[];
  modelsJsonContents: string | null;
  oauthProviders: ReturnType<AuthStorage["getOAuthProviders"]>;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
};

function prepareAgentFacts(
  input: PreparedModelRuntimeInput,
  catalogMode: PreparedModelRuntimeCatalogMode,
  ambientCredentials: Readonly<AgentCredentialMap>,
  additionalProviderIds: readonly string[] = [],
  includeCredentialProviders = catalogMode === "live",
): PreparedModelRuntimeAgentBaseFacts {
  const env = input.env ?? process.env;
  const preparedStore = loadPreparedModelRuntimeAuthStore(input);
  const authFacts = discoverAuthStorageFacts(input.agentDir, {
    config: input.config,
    // Prepared owners consume only the already-published runtime auth generation. External CLI
    // hydration belongs to startup/control-plane and turn-time producers, never rebuilds.
    readOnly: true,
    ambientCredentials,
    ...(preparedStore ? { preparedStore } : {}),
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
    // Keep order and case-distinct refs: registry lookup remains exact-case even
    // where static/dynamic completion deduplicates case-insensitive merge keys.
    configuredModelRefs: rawConfiguredModelRefs.flatMap(({ value }) => {
      const ref = parseModelCatalogRef(value);
      return ref ? [ref] : [];
    }),
    // Gateway startup prepares only providers named by config/model selection. An unrelated
    // stored credential must not pull that provider's complete catalog into the admission path.
    providerIds: [
      ...new Set([
        ...collectPreparedModelRuntimeProviderIds(
          input.config,
          credentials,
          includeCredentialProviders,
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
    includeCredentialProviders?: boolean;
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
    options.getConfiguredHarnessRuntimes,
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
        ...inputs.flatMap(({ config, agentId }) =>
          withAgentRosterFactsBatch(config, () => [
            ...collectPreparedModelRuntimeProviderIds(
              config,
              {},
              false,
              collectPreparedModelRuntimeConfiguredRefs(config, agentId),
              agentId,
            ),
            ...parseConfiguredModelVisibilityEntries({ cfg: config, agentId }).providerWildcards,
          ]),
        ),
        ...(options.providerDiscoveryProviderIds ?? []).map(normalizeProviderId).filter(Boolean),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
    const staticCatalogProviderIds = [
      ...new Set([
        ...collectConfiguredProviderIdsNeedingStaticCatalog({
          config: input.config,
          matchesStaticModelId,
          resolveStaticCatalogModel: resolveConfiguredManifestModel,
        }),
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
            staticCatalogProviderIds,
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
    // Static Gateway publication consumes discovery entrypoints; the run owns activation.
    const ambientCredentialsStartedAt = performance.now();
    const ambientCredentials = await prepareAmbientAgentCredentialsForDiscovery({
      config: input.config,
      env,
      authoritativeSyntheticAuthProviderRefs: pluginMetadataSnapshot.owners.cliBackends.keys(),
      syntheticAuthProviderRefs:
        catalogMode === "static"
          ? listPreparedSyntheticAuthProviderRefs(preparedSyntheticAuthProviders)
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
              prepareSyntheticAuth({
                config: input.config,
                env,
                workspaceDir: input.workspaceDir,
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
        prepareAgentFacts(
          candidate,
          catalogMode,
          ambientCredentials,
          options.providerDiscoveryProviderIds,
          options.includeCredentialProviders,
        ),
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
      const configuredEntryKeys = new Set(configuredCatalogEntries.map(modelCatalogEntryKey));
      for (const configured of configuredRuntimeModels) {
        configuredEntryKeys.add(
          modelCatalogEntryKey({ provider: configured.provider, id: configured.modelId }),
        );
      }
      const configuredGeneratedCatalogPluginIds = [
        ...new Set(
          facts.configuredModelRefs.flatMap(({ provider, modelId }) => {
            if (configuredEntryKeys.has(modelCatalogEntryKey({ provider, id: modelId }))) {
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

function captureModelsJsonContents(agentDir: string): string | null {
  try {
    return fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
export const fingerprintPreparedRuntimeFacts = (value: unknown): string =>
  sha256Base64Url(stableStringify(value));

/** Record discovery scope before config projection or auth-owner publication can replace it. */
export function preparedModelInventoryKey(input: PreparedModelRuntimeInput): string {
  const { models, auth, env } = input.config;
  const plugins = normalizePluginsConfig(input.config.plugins);
  for (const entry of Object.values(plugins.entries)) {
    entry.config ??= {};
  }
  return fingerprintPreparedRuntimeFacts({
    ...input,
    config: { models, auth, env, plugins },
    env: input.env ?? process.env,
    runtimePluginSelections: undefined,
    credentials: getRuntimeAuthProfileStoreCredentialsRevision(),
    order:
      getPreparedRuntimeAuthProfileStoreSnapshotCore(input.agentDir, input.inheritedAuthDir)
        ?.order ?? {},
  });
}
function hasSameOAuthProviderGeneration(
  left: ReturnType<AuthStorage["getOAuthProviders"]>,
  right: ReturnType<AuthStorage["getOAuthProviders"]>,
): boolean {
  // Match executable hooks by identity so distinct AuthStorage closure generations never merge.
  return (
    left.length === right.length &&
    left.every((provider, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        provider.id === candidate.id &&
        provider.name === candidate.name &&
        provider.usesCallbackServer === candidate.usesCallbackServer &&
        provider.login === candidate.login &&
        provider.refreshToken === candidate.refreshToken &&
        provider.getApiKey === candidate.getApiKey &&
        provider.modifyModels === candidate.modifyModels
      );
    })
  );
}

function groupConfiguredRegistrySources(
  agentFacts: readonly PreparedModelRuntimeAgentFacts[],
): PreparedConfiguredRegistryGroup[] {
  const groups = new Map<string, PreparedConfiguredRegistryGroup[]>();
  for (const facts of agentFacts) {
    const modelsJsonContents = captureModelsJsonContents(facts.input.agentDir);
    const oauthProviders = facts.templateAuthStorage.getOAuthProviders();
    // Capture only unresolved configured catalogs, then group exact bytes and OAuth behavior.
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(
      facts.input.agentDir,
      facts.configuredGeneratedCatalogPluginIds,
    );
    const key = fingerprintPreparedRuntimeFacts({
      credentials: facts.credentials,
      modelsJsonContents,
      pluginCatalogs,
    });
    const candidates = groups.get(key) ?? [];
    const group = candidates.find((candidate) =>
      hasSameOAuthProviderGeneration(candidate.oauthProviders, oauthProviders),
    );
    if (group) {
      group.agentFacts.push(facts);
    } else {
      candidates.push({
        agentFacts: [facts],
        modelsJsonContents,
        oauthProviders,
        pluginCatalogs,
      });
      groups.set(key, candidates);
    }
  }
  return [...groups.values()].flat();
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
  for (const group of groupConfiguredRegistrySources(params.agentFacts)) {
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
        pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        ...(representative.input.workspaceDir
          ? { workspaceDir: representative.input.workspaceDir }
          : {}),
      },
    );
    registryCount += 1;
    for (const facts of group.agentFacts) {
      const configuredRuntimeModels = completeConfiguredRuntimeModels(
        facts,
        params.pluginGeneration,
        templateModelRegistry,
      );
      catalogs.set(
        facts.input,
        prepareConfiguredRuntimeFacts({
          agentFacts: facts,
          workspaceFacts: params.pluginGeneration,
          templateModelRegistry,
          configuredRuntimeModels,
        }),
      );
    }
  }
  return { catalogs, registryCount };
}

export async function prepareAgentCatalogSource(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogMode: PreparedModelRuntimeCatalogMode,
  persist = true,
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
  // Read-only inventories can request live discovery without preparing a runtime registry.
  return pluginRegistry
    ? withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, prepareSource)
    : prepareSource();
}
