/**
 * Resolves bundled static catalog rows for embedded-agent model selection.
 */
import { normalizeResolvedPricing } from "@openclaw/llm-core";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../../model-catalog/index.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { listOpenClawPluginManifestMetadata } from "../../plugins/manifest-metadata-scan.js";
import { passesManifestOwnerBasePolicy } from "../../plugins/manifest-owner-policy.js";
import { loadPluginManifestRegistryCore } from "../../plugins/manifest-registry.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { getPluginCache, getPluginMetadataSnapshotCache } from "../../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog,
  type PreparedProviderStaticCatalog,
} from "../../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef,
} from "../../plugins/providers.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildInlineProviderModels, type InlineModelEntry } from "./model.inline-provider.js";
import type { BundledStaticCatalogState } from "./model.static-catalog.types.js";
import {
  createStaticModelIdMatcher,
  staticModelIdMatches,
  type StaticModelIdMatcher,
} from "./model.static-id.js";

export { resolveManifestModelCatalogProviderAliasMetadata } from "./model.manifest-alias.js";
export type { ManifestModelCatalogProviderAliasMetadata } from "./model.manifest-alias.js";

/**
 * Resolves bundled plugin static model-catalog rows into runtime model records.
 */
function rowMatchesModel(params: {
  row: NormalizedModelCatalogRow;
  provider: string;
  modelId: string;
  matchesStaticModelId: StaticModelIdMatcher;
}): boolean {
  return params.matchesStaticModelId({
    candidateId: params.row.id,
    provider: params.provider,
    modelId: params.modelId,
    rowProvider: params.row.provider,
  });
}

function normalizeStaticCatalogInput(
  input: readonly unknown[] | undefined,
): ProviderRuntimeModel["input"] {
  const normalizedInput = (input ?? []).filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalizedInput.length > 0 ? normalizedInput : ["text"];
}

/** Converts a normalized catalog row into the provider runtime model shape. */
function modelFromStaticCatalogRow(row: NormalizedModelCatalogRow): ProviderRuntimeModel {
  return {
    id: row.id,
    name: row.name || row.id,
    provider: row.provider,
    api: row.api ?? "openai-responses",
    baseUrl: row.baseUrl ?? "",
    reasoning: row.reasoning,
    input: normalizeStaticCatalogInput(row.input),
    cost: normalizeResolvedPricing(row.cost ?? {}),
    contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextWindows: row.contextWindows?.map((option) => ({ ...option })),
    contextWindowDefault: row.contextWindowDefault,
    contextTokens: row.contextTokens,
    maxTokens: row.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    thinkingLevelMap: row.thinkingLevelMap ? { ...row.thinkingLevelMap } : undefined,
    headers: row.headers,
    compat: row.compat,
    mediaInput: row.mediaInput,
  };
}

function completeProviderStaticCatalogModel(
  model: InlineModelEntry,
  providerConfig: ModelProviderConfig,
): ProviderRuntimeModel {
  return {
    ...model,
    name: model.name || model.id,
    api: model.api ?? providerConfig.api ?? "openai-responses",
    baseUrl: model.baseUrl ?? "",
    reasoning: model.reasoning ?? false,
    input: normalizeStaticCatalogInput(model.input),
    cost: model.cost ?? normalizeResolvedPricing({}),
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: model.contextTokens,
    maxTokens: model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    ...(providerConfig.authHeader !== undefined ? { authHeader: providerConfig.authHeader } : {}),
  };
}

type StaticCatalogPlugin = Parameters<
  typeof planEffectiveModelCatalogRows
>[0]["registry"]["plugins"][number];

type BundledStaticCatalogParams = {
  cfg?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
};

const defaultBundledStaticCatalogConfig: OpenClawConfig = {};

function resolveBundledStaticCatalogMetadataSnapshot(
  params: BundledStaticCatalogParams,
): PluginMetadataSnapshot | undefined {
  // Lifecycle callers pin the catalog to the plugin generation they are publishing.
  // Rediscovery here can mix generations and repeat manifest work for every model lookup.
  if (params.metadataSnapshot) {
    return params.metadataSnapshot;
  }
  const gatewaySnapshot = getGatewayPluginMetadataSnapshot();
  if (gatewaySnapshot) {
    return gatewaySnapshot;
  }
  if (params.env !== process.env) {
    return undefined;
  }
  return getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    env: params.env,
    workspaceDir: params.workspaceDir,
    ...(params.workspaceDir === undefined ? { allowWorkspaceScopedSnapshot: true } : {}),
    ...(params.cfg === undefined ? { requireDefaultDiscoveryContext: true } : {}),
  });
}

function listBundledStaticCatalogPlugins(
  params: BundledStaticCatalogParams,
  metadataSnapshot?: PluginMetadataSnapshot,
): StaticCatalogPlugin[] {
  const normalizedConfig = normalizePluginsConfig(params.cfg?.plugins);
  const plugins: StaticCatalogPlugin[] = metadataSnapshot
    ? metadataSnapshot.plugins
        .filter((plugin) => plugin.origin === "bundled")
        .map(({ id, providers, modelCatalog }) => ({ id, providers, modelCatalog }))
    : listOpenClawPluginManifestMetadata(params.env).flatMap((record): StaticCatalogPlugin[] => {
        if (record.origin !== "bundled") {
          return [];
        }
        const loaded = loadPluginManifest(record.pluginDir);
        return loaded.ok
          ? [
              {
                id: loaded.manifest.id,
                providers: loaded.manifest.providers,
                modelCatalog: loaded.manifest.modelCatalog,
              },
            ]
          : [];
      });
  return plugins.filter(
    (plugin) =>
      Boolean(plugin.modelCatalog) && passesManifestOwnerBasePolicy({ plugin, normalizedConfig }),
  );
}

function resolveBundledStaticCatalogState(
  params: BundledStaticCatalogParams,
  metadataSnapshot?: PluginMetadataSnapshot,
): BundledStaticCatalogState {
  const cache = metadataSnapshot
    ? getPluginMetadataSnapshotCache(metadataSnapshot)
    : getPluginCache();
  const bundledStaticCatalogStatesByOwner = cache.metadata.staticCatalogStates;
  const owner = metadataSnapshot ?? params.env;
  let states = bundledStaticCatalogStatesByOwner.get(owner);
  if (!states) {
    states = new WeakMap();
    bundledStaticCatalogStatesByOwner.set(owner, states);
  }
  const config = params.cfg ?? defaultBundledStaticCatalogConfig;
  const cached = states.get(config);
  if (cached) {
    return cached;
  }
  const state = {
    plugins: listBundledStaticCatalogPlugins(params, metadataSnapshot),
    plans: new Map<string, ReturnType<typeof planEffectiveModelCatalogRows>>(),
  };
  states.set(config, state);
  return state;
}

type BundledStaticCatalogLookup = {
  provider: string;
  modelId: string;
};

type BundledStaticCatalogContext = {
  contextWindow?: number;
  contextTokens?: number;
};

type BundledStaticCatalogScopedLookup = {
  lookup: BundledStaticCatalogLookup;
  pluginIds: string[];
};

type BundledProviderStaticCatalogResolverParams = {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerIds?: readonly string[];
};

/**
 * Prepares a process-stable bundled manifest catalog lookup.
 * Manifest discovery runs once; provider-specific plans are cached on demand.
 */
export function createBundledStaticCatalogModelResolver(params?: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeRuntimeDiscovery?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
}): (lookup: BundledStaticCatalogLookup) => ProviderRuntimeModel | undefined {
  const catalogParams = {
    cfg: params?.cfg,
    env: params?.env ?? process.env,
    ...(params?.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    workspaceDir: params?.workspaceDir,
  };
  const matchesStaticModelId = params?.metadataSnapshot
    ? createStaticModelIdMatcher({ manifestPlugins: params.metadataSnapshot })
    : staticModelIdMatches;
  return (lookup) => {
    const provider = normalizeProviderId(lookup.provider);
    if (!provider || !lookup.modelId.trim()) {
      return undefined;
    }
    const metadataSnapshot = resolveBundledStaticCatalogMetadataSnapshot(catalogParams);
    const state = resolveBundledStaticCatalogState(catalogParams, metadataSnapshot);
    if (state.plugins.length === 0) {
      return undefined;
    }
    let plan = state.plans.get(provider);
    if (!plan) {
      plan = planEffectiveModelCatalogRows({
        registry: { plugins: state.plugins },
        config: params?.cfg ?? {},
        providerFilter: provider,
      });
      state.plans.set(provider, plan);
    }
    for (const entry of plan.entries) {
      if (
        entry.discovery !== "static" &&
        !(
          params?.includeRuntimeDiscovery &&
          (entry.discovery === "runtime" || entry.discovery === "refreshable")
        )
      ) {
        continue;
      }
      const row = entry.rows.find((candidate: NormalizedModelCatalogRow) =>
        rowMatchesModel({
          row: candidate,
          provider,
          modelId: lookup.modelId,
          matchesStaticModelId,
        }),
      );
      if (row) {
        return modelFromStaticCatalogRow(row);
      }
    }
    return undefined;
  };
}

/** Resolves one bundled static-catalog model row for provider/model lookup. */
export function resolveBundledStaticCatalogModel(
  params: BundledStaticCatalogLookup & {
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeRuntimeDiscovery?: boolean;
    metadataSnapshot?: PluginMetadataSnapshot;
  },
): ProviderRuntimeModel | undefined {
  return createBundledStaticCatalogModelResolver({
    cfg: params.cfg,
    ...(params.env ? { env: params.env } : {}),
    ...(params.includeRuntimeDiscovery !== undefined
      ? { includeRuntimeDiscovery: params.includeRuntimeDiscovery }
      : {}),
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  })(params);
}

function resolveBundledProviderStaticCatalogPluginIds(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): string[] {
  const pluginIds = resolveOwningPluginIdsForProviderRef({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
  });
  if (!pluginIds || pluginIds.length === 0) {
    return [];
  }
  const activatablePluginIds = resolveActivatableProviderOwnerPluginIds({
    pluginIds,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(params.metadataSnapshot
      ? {
          registry: params.metadataSnapshot.index,
          manifestRegistry: params.metadataSnapshot.manifestRegistry,
        }
      : {}),
  });
  if (activatablePluginIds.length === 0) {
    return [];
  }
  const bundledPluginIds = new Set(
    resolveBundledProviderCompatPluginIds({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      ...(params.metadataSnapshot
        ? { manifestRegistry: params.metadataSnapshot.manifestRegistry }
        : {}),
    }),
  );
  return activatablePluginIds.filter((pluginId) => bundledPluginIds.has(pluginId)).toSorted();
}

async function loadBundledProviderStaticCatalogModels(params: {
  pluginIds: string[];
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerMetadataOwners?: PluginMetadataSnapshot["owners"];
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): Promise<Map<string, ProviderRuntimeModel[]>> {
  const pluginIds = new Set(params.pluginIds);
  const preparedProviders = (params.preparedStaticProviderCatalog?.providers ?? []).filter(
    (provider) => provider.pluginId !== undefined && pluginIds.has(provider.pluginId),
  );
  const preparedPluginIds = new Set(
    preparedProviders.flatMap((provider) => (provider.pluginId ? [provider.pluginId] : [])),
  );
  const missingPluginIds = params.pluginIds.filter((pluginId) => !preparedPluginIds.has(pluginId));
  // Prepared provider lists are complete only for the plugin ids they name. Full catalog reads
  // must still discover omitted plugins, while reusing cached hook results for covered providers.
  const discoveredProviders =
    missingPluginIds.length === 0
      ? []
      : await resolveRuntimePluginDiscoveryProviders({
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env: params.env,
          onlyPluginIds: missingPluginIds,
          includeUntrustedWorkspacePlugins: false,
          requireCompleteDiscoveryEntryCoverage: true,
          discoveryEntriesOnly: true,
          includeManifestModelCatalogProviders: false,
          ...(params.pluginMetadataSnapshot
            ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
            : {}),
        });
  const providers = [...preparedProviders, ...discoveredProviders];
  const preparedEntries = params.preparedStaticProviderCatalog?.entries.filter(
    ({ provider }) => provider.pluginId !== undefined && pluginIds.has(provider.pluginId),
  );
  const preparedResults = preparedEntries
    ? new Map(
        preparedEntries.map(({ provider, result }) => [
          `${provider.pluginId ?? ""}\0${normalizeProviderId(provider.id)}`,
          result,
        ]),
      )
    : undefined;
  const modelsByProvider = new Map<string, ProviderRuntimeModel[]>();
  for (const catalogProvider of providers) {
    const preparedResultKey = `${catalogProvider.pluginId ?? ""}\0${normalizeProviderId(catalogProvider.id)}`;
    const result = preparedResults?.has(preparedResultKey)
      ? preparedResults.get(preparedResultKey)
      : await runProviderStaticCatalog({ provider: catalogProvider });
    const normalized = normalizePluginDiscoveryResult({
      provider: catalogProvider,
      result,
    });
    for (const [providerIdRaw, providerConfig] of Object.entries(normalized)) {
      const provider = normalizeProviderId(providerIdRaw);
      // Empty catalogs never resolve request secrets or transport settings.
      if (
        !provider ||
        !Array.isArray(providerConfig.models) ||
        providerConfig.models.length === 0
      ) {
        continue;
      }
      const models = modelsByProvider.get(provider) ?? [];
      models.push(
        ...buildInlineProviderModels(
          { [provider]: providerConfig },
          { providerMetadataOwners: params.providerMetadataOwners },
        ).map((model) => completeProviderStaticCatalogModel(model, providerConfig)),
      );
      modelsByProvider.set(provider, models);
    }
  }
  return modelsByProvider;
}

/** Loads all enabled bundled provider static-catalog rows without live discovery or writes. */
export async function loadBundledProviderStaticCatalogContextModels(
  params: BundledProviderStaticCatalogResolverParams = {},
): Promise<ProviderRuntimeModel[]> {
  const env = params.env ?? process.env;
  const metadataSnapshot = resolveBundledStaticCatalogMetadataSnapshot({
    cfg: params.cfg,
    env,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    workspaceDir: params.workspaceDir,
  });
  const discoveryEntryPluginIds = new Set(
    (
      metadataSnapshot?.manifestRegistry?.plugins ??
      loadPluginManifestRegistryCore({
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        env,
      }).plugins
    ).flatMap((plugin) =>
      plugin.origin === "bundled" && plugin.providerDiscoverySource ? [plugin.id] : [],
    ),
  );
  const providerScopedPluginIds = params.providerIds?.flatMap((provider) =>
    resolveBundledProviderStaticCatalogPluginIds({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
      ...(metadataSnapshot ? { metadataSnapshot } : {}),
    }),
  );
  const candidatePluginIds =
    providerScopedPluginIds === undefined
      ? resolveBundledProviderCompatPluginIds({
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env,
          ...(metadataSnapshot ? { manifestRegistry: metadataSnapshot.manifestRegistry } : {}),
        })
      : providerScopedPluginIds;
  const pluginIds = [...new Set(candidatePluginIds)]
    .filter((pluginId) => discoveryEntryPluginIds.has(pluginId))
    .toSorted((left, right) => left.localeCompare(right));
  if (pluginIds.length === 0) {
    return [];
  }
  const catalogs = await Promise.allSettled(
    pluginIds.map(
      async (pluginId) =>
        await loadBundledProviderStaticCatalogModels({
          pluginIds: [pluginId],
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          env,
          ...(params.preparedStaticProviderCatalog
            ? { preparedStaticProviderCatalog: params.preparedStaticProviderCatalog }
            : {}),
          ...(metadataSnapshot ? { providerMetadataOwners: metadataSnapshot.owners } : {}),
          ...(metadataSnapshot ? { pluginMetadataSnapshot: metadataSnapshot } : {}),
        }),
    ),
  );
  return catalogs.flatMap((result) =>
    result.status === "fulfilled" ? [...result.value.values()].flat() : [],
  );
}

function createScopedBundledProviderStaticCatalogModelResolver(
  params: BundledProviderStaticCatalogResolverParams = {},
): (
  lookup: BundledStaticCatalogLookup,
  scopedPluginIds?: string[],
) => Promise<ProviderRuntimeModel | undefined> {
  const env = params.env ?? process.env;
  const matchesStaticModelId = params.metadataSnapshot
    ? createStaticModelIdMatcher({ manifestPlugins: params.metadataSnapshot })
    : staticModelIdMatches;
  const pluginCatalogs = new Map<string, Promise<Map<string, ProviderRuntimeModel[]>>>();
  const providerPluginIds = new Map<string, string[]>();
  return async (lookup, scopedPluginIds) => {
    const provider = normalizeProviderId(lookup.provider);
    if (!provider || !lookup.modelId.trim()) {
      return undefined;
    }
    let pluginIds = scopedPluginIds;
    if (!pluginIds) {
      pluginIds = providerPluginIds.get(provider);
    }
    if (!pluginIds) {
      pluginIds = resolveBundledProviderStaticCatalogPluginIds({
        provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        env,
        ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
      });
      providerPluginIds.set(provider, pluginIds);
    }
    if (pluginIds.length === 0) {
      return undefined;
    }
    const catalogKey = pluginIds.join("\0");
    let catalog = pluginCatalogs.get(catalogKey);
    if (!catalog) {
      catalog = loadBundledProviderStaticCatalogModels({
        pluginIds,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        env,
        ...(params.preparedStaticProviderCatalog
          ? { preparedStaticProviderCatalog: params.preparedStaticProviderCatalog }
          : {}),
        ...(params.metadataSnapshot
          ? {
              providerMetadataOwners: params.metadataSnapshot.owners,
              pluginMetadataSnapshot: params.metadataSnapshot,
            }
          : {}),
      });
      pluginCatalogs.set(catalogKey, catalog);
    }
    return ((await catalog).get(provider) ?? []).find((candidate) =>
      matchesStaticModelId({
        candidateId: candidate.id,
        provider,
        modelId: lookup.modelId,
      }),
    );
  };
}

function resolveOwnedNestedProviderLookup(params: {
  lookup: BundledStaticCatalogLookup;
  resolverParams: BundledProviderStaticCatalogResolverParams;
  env: NodeJS.ProcessEnv;
}): BundledStaticCatalogScopedLookup | undefined {
  const provider = normalizeProviderId(params.lookup.provider);
  const modelId = params.lookup.modelId.trim();
  const slash = modelId.indexOf("/");
  if (!provider || slash <= 0 || slash >= modelId.length - 1) {
    return undefined;
  }
  const nestedProvider = normalizeProviderId(modelId.slice(0, slash));
  const nestedModelId = modelId.slice(slash + 1).trim();
  if (!nestedProvider || nestedProvider === provider || !nestedModelId) {
    return undefined;
  }
  const resolveBundledOwners = (candidateProvider: string) =>
    resolveBundledProviderStaticCatalogPluginIds({
      provider: candidateProvider,
      cfg: params.resolverParams.cfg,
      workspaceDir: params.resolverParams.workspaceDir,
      env: params.env,
      ...(params.resolverParams.metadataSnapshot
        ? { metadataSnapshot: params.resolverParams.metadataSnapshot }
        : {}),
    });
  const nestedProviderOwners = new Set(resolveBundledOwners(nestedProvider));
  const sharedPluginIds = resolveBundledOwners(provider).filter((pluginId) =>
    nestedProviderOwners.has(pluginId),
  );
  if (sharedPluginIds.length === 0) {
    return undefined;
  }
  return {
    lookup: { provider: nestedProvider, modelId: nestedModelId },
    pluginIds: sharedPluginIds,
  };
}

/**
 * Prepares context-only provider catalog lookup.
 * Nested provider refs may reuse metadata only when both providers have the same plugin owner.
 */
export function createBundledProviderStaticCatalogContextResolver(
  params: BundledProviderStaticCatalogResolverParams = {},
): (lookup: BundledStaticCatalogLookup) => Promise<BundledStaticCatalogContext | undefined> {
  const env = params.env ?? process.env;
  const resolveModel = createScopedBundledProviderStaticCatalogModelResolver(params);
  return async (lookup) => {
    const exactModel = await resolveModel(lookup);
    const nested = exactModel
      ? undefined
      : resolveOwnedNestedProviderLookup({ lookup, resolverParams: params, env });
    const model =
      exactModel ?? (nested ? await resolveModel(nested.lookup, nested.pluginIds) : undefined);
    if (!model) {
      return undefined;
    }
    return {
      ...(typeof model.contextWindow === "number" && model.contextWindow > 0
        ? { contextWindow: model.contextWindow }
        : {}),
      ...(typeof model.contextTokens === "number" && model.contextTokens > 0
        ? { contextTokens: model.contextTokens }
        : {}),
    };
  };
}

/**
 * Resolves one bundled provider static-catalog model row for provider/model lookup.
 *
 * Some bundled providers expose their canonical offline rows through
 * `providerCatalogEntry` instead of manifest `modelCatalog`. This keeps the
 * skip-discovery fallback aligned with model list/inspect without running live
 * discovery or untrusted workspace plugins.
 */
export async function resolveBundledProviderStaticCatalogModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ProviderRuntimeModel | undefined> {
  return createScopedBundledProviderStaticCatalogModelResolver(params)(params);
}
