import { isDeepStrictEqual } from "node:util";
import type { Model } from "../llm/types.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { discoverModels } from "./agent-model-discovery.js";
import { getPreparedRuntimeAuthMaterializations } from "./auth-profiles/runtime-materializations.js";
import { loadBundledProviderStaticCatalogContextModels } from "./embedded-agent-runner/model.static-catalog.js";
import { compareModelCatalogEntries } from "./model-catalog-order.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import {
  getPreparedModelFullCatalogAuth,
  setPreparedModelFullCatalogAuth,
  setPreparedModelRuntimeAuthMaterializations,
  setPreparedModelRuntimeAuthLoader,
  setPreparedModelRuntimeAuthStore,
  type PreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import { completeConfiguredRuntimeModels } from "./prepared-model-runtime.configured-completion.js";
import {
  toStaticCatalogEntry,
  type PreparedConfiguredRuntimeModel,
  type PreparedRuntimeCapabilityModel,
} from "./prepared-model-runtime.configured.js";
import { buildPreparedPluginModelCatalog } from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const fullModelCatalogSnapshots = new WeakSet<ModelCatalogSnapshot>();

/** Builds complete inventory before generation-specific runtime capability projection. */
export async function prepareFullCatalogFacts(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogMode: PreparedModelRuntimeCatalogMode,
  catalogSource?: PreparedModelRuntimeCatalogSource,
): Promise<PreparedModelRuntimeCatalogFacts> {
  const { env, input, templateAuthStorage } = agentFacts;
  const { pluginMetadataSnapshot, preparedStaticProviderCatalog } = pluginGeneration;
  const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    pluginMetadataSnapshot,
    ...(catalogMode === "static" ? { normalizeModels: false } : {}),
    ...(catalogSource
      ? {
          includePluginCatalogs: true,
          modelsJsonContents: catalogSource.modelsJsonContents,
          pluginCatalogs: catalogSource.pluginCatalogs,
        }
      : {}),
  });
  const modelCatalog = await buildPreparedPluginModelCatalog({
    agentFacts,
    catalogMode,
    modelRegistry: templateModelRegistry,
    providerOutcomes: catalogSource?.providerOutcomes,
    pluginGeneration,
  });
  const providerStaticModels =
    pluginGeneration.providerStaticModels ??
    (await loadBundledProviderStaticCatalogContextModels({
      cfg: input.config,
      env,
      metadataSnapshot: pluginMetadataSnapshot,
      registeredProviders: pluginGeneration.pluginRegistry?.providers,
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    }));
  const configuredRuntimeModels = completeConfiguredRuntimeModels(
    agentFacts,
    pluginGeneration,
    templateModelRegistry,
  );
  const providerOutcomes = catalogSource?.providerOutcomes ?? [];
  const completeModelCatalog = {
    ...modelCatalog,
    staticEntries: dedupeByKey(providerStaticModels, resolveModelCatalogIdentityKey).map(
      toStaticCatalogEntry,
    ),
    ...(providerOutcomes.length > 0 ? { providerOutcomes } : {}),
  };
  if (catalogMode === "live") {
    fullModelCatalogSnapshots.add(completeModelCatalog);
  }
  return {
    templateModelRegistry,
    modelCatalog: completeModelCatalog,
    configuredRuntimeModels,
    inlineProviderModels: pluginGeneration.inlineProviderModels,
  };
}

export function prepareModelCatalogPublication(
  discovered: ModelCatalogSnapshot,
  inventory: PreparedModelCatalogInventory | undefined,
  auth: PreparedModelCatalogAuth,
  normalizeProvider: (provider: string) => string,
): Pick<PreparedModelCatalogInventory, "catalog" | "discoveryOrigins"> {
  // Native observations belong to this runtime generation, not retained provider inventory.
  const catalog: ModelCatalogSnapshot = {
    ...discovered,
    entries: dedupeByKey(
      [...discovered.entries, ...discovered.routeVariants].filter((entry) => !entry.nativeRuntime),
      resolveModelCatalogIdentityKey,
    ),
    routeVariants: discovered.routeVariants.filter((entry) => !entry.nativeRuntime),
  };
  setPreparedModelFullCatalogAuth(catalog, auth);
  const failed = catalog.providerOutcomes?.filter((outcome) => outcome.status !== "ready") ?? [];
  const discoveryOrigins = (catalog.providerOutcomes ?? [])
    .filter((outcome) => outcome.status === "ready")
    .map(({ provider, profileId }) => ({ provider: normalizeProvider(provider), profileId }));
  if (failed.length === 0) {
    return { catalog, discoveryOrigins };
  }
  const previous = inventory?.catalog;
  const previousAuth = previous && getPreparedModelFullCatalogAuth(previous);
  const starterProviders = new Set(
    failed
      .map(({ provider }) => normalizeProvider(provider))
      .filter((provider) => !discoveryOrigins.some((origin) => origin.provider === provider)),
  );
  const starters = (catalog.staticEntries ?? []).filter(
    (entry) => !entry.nativeRuntime && starterProviders.has(normalizeProvider(entry.provider)),
  );
  const retainedProviders = new Set(
    failed.flatMap((outcome) => {
      const provider = normalizeProvider(outcome.provider);
      const previousOrigins = inventory?.discoveryOrigins.filter(
        (candidate) => normalizeProvider(candidate.provider) === provider,
      );
      if (
        discoveryOrigins.some((origin) => origin.provider === provider) ||
        (!previousOrigins?.length &&
          previous?.providerOutcomes?.some(
            (candidate) => normalizeProvider(candidate.provider) === provider,
          )) ||
        !previousAuth ||
        !previousAuth.credentials ||
        !auth.credentials ||
        (outcome.profileId !== undefined &&
          !previousOrigins?.some((candidate) => candidate.profileId === outcome.profileId)) ||
        previousAuth.authModes[provider] !== auth.authModes[provider]
      ) {
        return [];
      }
      const providerProfiles = (value: PreparedModelCatalogAuth) =>
        Object.fromEntries(
          Object.entries(value.authStore.profiles).filter(
            ([, profile]) => normalizeProvider(profile.provider) === provider,
          ),
        );
      const providerCredentials = (
        credentials: NonNullable<PreparedModelCatalogAuth["credentials"]>,
      ) =>
        Object.entries(credentials)
          .filter(([candidate]) => normalizeProvider(candidate) === provider)
          .map(([, credential]) => credential);
      return isDeepStrictEqual(providerProfiles(previousAuth), providerProfiles(auth)) &&
        isDeepStrictEqual(
          providerCredentials(previousAuth.credentials),
          providerCredentials(auth.credentials),
        )
        ? [provider]
        : [];
    }),
  );
  const retain = (
    current: ModelCatalogSnapshot["entries"],
    retained: ModelCatalogSnapshot["entries"],
    key: (entry: ModelCatalogSnapshot["entries"][number]) => string,
  ) =>
    dedupeByKey(
      [
        ...[...current, ...starters].filter(
          (entry) => !retainedProviders.has(normalizeProvider(entry.provider)),
        ),
        ...retained.filter(
          (entry) =>
            !entry.nativeRuntime && retainedProviders.has(normalizeProvider(entry.provider)),
        ),
      ],
      key,
    ).toSorted(compareModelCatalogEntries);
  const published: ModelCatalogSnapshot = {
    ...catalog,
    entries: retain(catalog.entries, previous?.entries ?? [], resolveModelCatalogIdentityKey),
    routeVariants: retain(catalog.routeVariants, previous?.routeVariants ?? [], (entry) =>
      JSON.stringify([
        resolveModelCatalogIdentityKey(entry),
        entry.api,
        entry.baseUrl,
        entry.nativeRuntime,
      ]),
    ),
    authoritative: false,
  };
  setPreparedModelFullCatalogAuth(published, auth);
  return {
    catalog: published,
    discoveryOrigins: [
      ...discoveryOrigins,
      ...(inventory?.discoveryOrigins ?? []).filter((origin) =>
        retainedProviders.has(normalizeProvider(origin.provider)),
      ),
    ],
  };
}

/** Reprojects retained inventory without carrying capabilities from a retired runtime. */
export function materializePreparedModelCatalog(
  snapshot: ModelCatalogSnapshot,
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[],
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[] = [],
): ModelCatalogSnapshot {
  // Preserve inventory reads before capability preparation when the snapshot has accessors.
  const materialized = { ...snapshot };
  const sourceEntries = snapshot.entries;
  const runtimeByKey = new Map(
    runtimeCapabilityModels.map(({ provider, modelId, model }) => [
      resolveModelCatalogIdentityKey({ provider, id: modelId }),
      toStaticCatalogEntry(model),
    ]),
  );
  const project = (entries: ModelCatalogSnapshot["entries"]) =>
    entries.map((entry) => {
      const runtime = runtimeByKey.get(resolveModelCatalogIdentityKey(entry));
      if (!runtime) {
        return entry;
      }
      const thinkingPolicyProvider = runtime.provider;
      if (entry.configuredReasoning !== undefined) {
        return { ...entry, thinkingPolicyProvider };
      }
      const params =
        runtime.params || entry.params ? { ...runtime.params, ...entry.params } : undefined;
      const compat =
        runtime.compat || entry.compat ? { ...runtime.compat, ...entry.compat } : undefined;
      return {
        ...entry,
        thinkingPolicyProvider,
        ...(runtime.reasoning !== undefined ? { reasoning: runtime.reasoning } : {}),
        ...(params ? { params } : {}),
        ...(compat ? { compat } : {}),
      };
    });
  materialized.entries = project(sourceEntries);
  materialized.routeVariants = project(snapshot.routeVariants);
  if (snapshot.staticEntries || configuredRuntimeModels.length > 0) {
    materialized.staticEntries = project(
      dedupeByKey(
        [
          ...configuredRuntimeModels.map(({ model }) => toStaticCatalogEntry(model)),
          ...(snapshot.staticEntries ?? []),
        ],
        resolveModelCatalogIdentityKey,
      ),
    );
  }
  if (isPreparedModelCatalogFull(snapshot)) {
    markPreparedModelCatalogFull(materialized);
  }
  const auth = getPreparedModelFullCatalogAuth(snapshot);
  if (auth) {
    setPreparedModelFullCatalogAuth(materialized, auth);
  }
  return materialized;
}

/** Reports whether a catalog came from the complete prepared-catalog build path. */
export const isPreparedModelCatalogFull = (snapshot: ModelCatalogSnapshot): boolean =>
  fullModelCatalogSnapshots.has(snapshot);

/** Restores process-local provenance after a complete catalog crosses a worker boundary. */
export function markPreparedModelCatalogFull(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  fullModelCatalogSnapshots.add(snapshot);
  return snapshot;
}

export type PreparedModelRuntimeCatalogAccess = Readonly<{
  isCurrent: () => boolean;
  readFullModelCatalog: () => ModelCatalogSnapshot | undefined;
  loadFullModelCatalog: (options?: { refresh?: boolean }) => Promise<ModelCatalogSnapshot>;
  loadAuth: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>;
}>;
export function createPreparedModelRuntimeSnapshot(
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"],
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogFacts: PreparedModelRuntimeCatalogFacts,
  catalogAccess: PreparedModelRuntimeCatalogAccess,
): PreparedModelRuntimeSnapshot {
  const { credentials, input } = agentFacts;
  const { mediaCapabilityProviders, messageToolCatalog, pluginMetadataSnapshot, pluginRegistry } =
    pluginGeneration;
  const { configuredRuntimeModels, inlineProviderModels, templateModelRegistry } = catalogFacts;
  const modelCatalog = materializePreparedModelCatalog(
    catalogFacts.modelCatalog,
    agentFacts.runtimeCapabilityModels,
    configuredRuntimeModels,
  );
  prepareModelCatalogThinkingPolicies({
    catalog: modelCatalog,
    metadataSnapshot: pluginMetadataSnapshot,
    providers: pluginRegistry?.providers,
  });
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  const snapshot: PreparedModelRuntimeSnapshot = Object.freeze({
    catalogOwner,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    activeProjectKeys: [],
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: input.config,
    observationConfig: input.config,
    isCurrent: catalogAccess.isCurrent,
    authModes: resolveUsableAgentCredentialModes(credentials),
    metadataSnapshot: pluginMetadataSnapshot,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ...(messageToolCatalog ? { messageToolCatalog } : {}),
    ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
    modelCatalog,
    readFullModelCatalog: catalogAccess.readFullModelCatalog,
    loadFullModelCatalog: catalogAccess.loadFullModelCatalog,
    configuredRuntimeModels,
    inlineProviderModels,
    createStores,
    routeModelResolutionMemo: new Map<string, Promise<Model>>(),
  });
  setPreparedModelRuntimeAuthStore(snapshot, agentFacts.authStore);
  setPreparedModelRuntimeAuthLoader(snapshot, catalogAccess.loadAuth);
  setPreparedModelRuntimeAuthMaterializations(
    snapshot,
    Object.freeze([...getPreparedRuntimeAuthMaterializations(input.agentDir)]),
  );
  return snapshot;
}
