/**
 * Resolves bundled static catalog rows for embedded-agent model selection.
 */
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planManifestModelCatalogRows } from "../../model-catalog/manifest-planner.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { listOpenClawPluginManifestMetadata } from "../../plugins/manifest-metadata-scan.js";
import { passesManifestOwnerBasePolicy } from "../../plugins/manifest-owner-policy.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import {
  normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog,
} from "../../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef,
} from "../../plugins/providers.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";

/**
 * Resolves bundled plugin static model-catalog rows into runtime model records.
 */
function rowMatchesModel(params: {
  row: NormalizedModelCatalogRow;
  provider: string;
  modelId: string;
}): boolean {
  return staticModelIdMatches({
    candidateId: params.row.id,
    provider: params.provider,
    modelId: params.modelId,
    rowProvider: params.row.provider,
  });
}

function staticModelIdMatches(params: {
  candidateId: string;
  provider: string;
  modelId: string;
  rowProvider?: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (params.rowProvider && normalizeProviderId(params.rowProvider) !== normalizedProvider) {
    return false;
  }
  return (
    normalizeStaticProviderModelId(normalizedProvider, params.candidateId).trim().toLowerCase() ===
    normalizeStaticProviderModelId(normalizedProvider, params.modelId).trim().toLowerCase()
  );
}

function normalizeStaticCatalogInput(
  input: readonly unknown[] | undefined,
): ProviderRuntimeModel["input"] {
  const normalizedInput = (input ?? []).filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalizedInput.length > 0 ? normalizedInput : ["text"];
}

function normalizeStaticCatalogCost(
  cost: NormalizedModelCatalogRow["cost"],
): ProviderRuntimeModel["cost"] {
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cacheRead ?? 0,
    cacheWrite: cost?.cacheWrite ?? 0,
  };
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
    cost: normalizeStaticCatalogCost(row.cost),
    contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: row.contextTokens,
    maxTokens: row.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    thinkingLevelMap: row.thinkingLevelMap ? { ...row.thinkingLevelMap } : undefined,
    headers: row.headers,
    compat: row.compat,
    mediaInput: row.mediaInput,
  };
}

function modelFromProviderStaticCatalog(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelProviderConfig["models"][number];
}): ProviderRuntimeModel {
  const [model] = buildInlineProviderModels({
    [params.provider]: { ...params.providerConfig, models: [params.model] },
  });
  return {
    ...model,
    id: model?.id ?? params.model.id,
    name: model?.name || params.model.name || params.model.id,
    provider: params.provider,
    api: model?.api ?? params.model.api ?? params.providerConfig.api ?? "openai-responses",
    baseUrl: model?.baseUrl ?? params.model.baseUrl ?? params.providerConfig.baseUrl ?? "",
    reasoning: model?.reasoning ?? params.model.reasoning ?? false,
    input: normalizeStaticCatalogInput(model?.input ?? params.model.input),
    cost: model?.cost ?? normalizeStaticCatalogCost(params.model.cost),
    contextWindow:
      model?.contextWindow ??
      params.model.contextWindow ??
      params.providerConfig.contextWindow ??
      DEFAULT_CONTEXT_TOKENS,
    contextTokens:
      model?.contextTokens ?? params.model.contextTokens ?? params.providerConfig.contextTokens,
    maxTokens:
      model?.maxTokens ??
      params.model.maxTokens ??
      params.providerConfig.maxTokens ??
      DEFAULT_CONTEXT_TOKENS,
    ...(params.providerConfig.authHeader !== undefined
      ? { authHeader: params.providerConfig.authHeader }
      : {}),
  };
}

type StaticCatalogPlugin = Parameters<
  typeof planManifestModelCatalogRows
>[0]["registry"]["plugins"][number];

function listBundledStaticCatalogPlugins(params: {
  cfg?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): StaticCatalogPlugin[] {
  const normalizedConfig = normalizePluginsConfig(params.cfg?.plugins);
  return listOpenClawPluginManifestMetadata(params.env).flatMap((record): StaticCatalogPlugin[] => {
    if (record.origin !== "bundled") {
      return [];
    }
    const loaded = loadPluginManifest(record.pluginDir);
    if (!loaded.ok || !loaded.manifest.modelCatalog) {
      return [];
    }
    if (
      !passesManifestOwnerBasePolicy({
        plugin: { id: loaded.manifest.id },
        normalizedConfig,
      })
    ) {
      return [];
    }
    return [
      {
        id: loaded.manifest.id,
        providers: loaded.manifest.providers,
        modelCatalog: loaded.manifest.modelCatalog,
      },
    ];
  });
}

function resolveManifestModelCatalogProviderAlias(params: {
  provider: string;
  plugins: readonly Pick<PluginManifestRecord, "providers" | "modelCatalog">[];
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return undefined;
  }
  const targets = new Set<string>();
  for (const plugin of params.plugins) {
    for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      const normalizedAlias = normalizeProviderId(rawAlias);
      const normalizedTarget = normalizeProviderId(alias.provider);
      if (
        normalizedAlias === provider &&
        normalizedTarget &&
        plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedTarget)
      ) {
        targets.add(normalizedTarget);
      }
    }
  }
  return targets.size === 1 ? [...targets][0] : undefined;
}

/** Resolves a provider alias from plugin model-catalog metadata when the alias is unambiguous. */
export function canonicalizeManifestModelCatalogProviderAlias(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return params.provider;
  }
  const env = params.env ?? process.env;
  // Gateway plugin metadata is process-stable. Reuse its lifecycle-owned snapshot
  // so every model turn does not rediscover the same manifest alias table.
  const currentPlugins =
    env === process.env
      ? getCurrentPluginMetadataSnapshot({
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env,
          ...(params.cfg === undefined ? { requireDefaultDiscoveryContext: true } : {}),
        })?.plugins
      : undefined;
  const plugins =
    currentPlugins ??
    loadPluginManifestRegistry({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
    }).plugins;
  return (
    resolveManifestModelCatalogProviderAlias({
      provider,
      plugins,
    }) ?? params.provider
  );
}

/** Returns whether a bundled static catalog asks runtime discovery to augment its rows. */
export function bundledStaticCatalogProviderUsesRuntimeAugment(params: {
  provider: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return false;
  }
  return listBundledStaticCatalogPlugins({
    cfg: params.cfg,
    env: params.env ?? process.env,
  }).some((plugin) => {
    const catalog = plugin.modelCatalog;
    if (catalog?.runtimeAugment !== true) {
      return false;
    }
    return (
      Object.keys(catalog.providers ?? {}).some(
        (candidate) => normalizeProviderId(candidate) === provider,
      ) ||
      Object.keys(catalog.aliases ?? {}).some(
        (candidate) => normalizeProviderId(candidate) === provider,
      )
    );
  });
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
};

/**
 * Prepares a process-stable bundled manifest catalog lookup.
 * Manifest discovery runs once; provider-specific plans are cached on demand.
 */
export function createBundledStaticCatalogModelResolver(params?: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeRuntimeDiscovery?: boolean;
}): (lookup: BundledStaticCatalogLookup) => ProviderRuntimeModel | undefined {
  const bundledStaticPlugins = listBundledStaticCatalogPlugins({
    cfg: params?.cfg,
    env: params?.env ?? process.env,
  });
  const plans = new Map<string, ReturnType<typeof planManifestModelCatalogRows>>();
  return (lookup) => {
    const provider = normalizeProviderId(lookup.provider);
    if (!provider || !lookup.modelId.trim() || bundledStaticPlugins.length === 0) {
      return undefined;
    }
    let plan = plans.get(provider);
    if (!plan) {
      plan = planManifestModelCatalogRows({
        registry: { plugins: bundledStaticPlugins },
        providerFilter: provider,
      });
      plans.set(provider, plan);
    }
    for (const entry of plan.entries) {
      if (
        entry.discovery !== "static" &&
        !(params?.includeRuntimeDiscovery && entry.discovery === "runtime")
      ) {
        continue;
      }
      const row = entry.rows.find((candidate) =>
        rowMatchesModel({
          row: candidate,
          provider,
          modelId: lookup.modelId,
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
  },
): ProviderRuntimeModel | undefined {
  return createBundledStaticCatalogModelResolver({
    cfg: params.cfg,
    ...(params.env ? { env: params.env } : {}),
    ...(params.includeRuntimeDiscovery !== undefined
      ? { includeRuntimeDiscovery: params.includeRuntimeDiscovery }
      : {}),
  })(params);
}

function resolveBundledProviderStaticCatalogPluginIds(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const pluginIds = resolveOwningPluginIdsForProviderRef({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (!pluginIds || pluginIds.length === 0) {
    return [];
  }
  const activatablePluginIds = resolveActivatableProviderOwnerPluginIds({
    pluginIds,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (activatablePluginIds.length === 0) {
    return [];
  }
  const bundledPluginIds = new Set(
    resolveBundledProviderCompatPluginIds({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }),
  );
  return activatablePluginIds.filter((pluginId) => bundledPluginIds.has(pluginId)).toSorted();
}

async function loadBundledProviderStaticCatalogModels(params: {
  pluginIds: string[];
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): Promise<Map<string, ProviderRuntimeModel[]>> {
  const providers = await resolveRuntimePluginDiscoveryProviders({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.pluginIds,
    includeUntrustedWorkspacePlugins: false,
    requireCompleteDiscoveryEntryCoverage: true,
    discoveryEntriesOnly: true,
    includeManifestModelCatalogProviders: false,
  });
  const modelsByProvider = new Map<string, ProviderRuntimeModel[]>();
  for (const catalogProvider of providers) {
    const result = await runProviderStaticCatalog({
      provider: catalogProvider,
      config: params.cfg ?? {},
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
    const normalized = normalizePluginDiscoveryResult({
      provider: catalogProvider,
      result,
    });
    for (const [providerIdRaw, providerConfig] of Object.entries(normalized)) {
      const provider = normalizeProviderId(providerIdRaw);
      if (!provider || !Array.isArray(providerConfig.models)) {
        continue;
      }
      const models = modelsByProvider.get(provider) ?? [];
      models.push(
        ...providerConfig.models.map((model) =>
          modelFromProviderStaticCatalog({
            provider,
            providerConfig,
            model,
          }),
        ),
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
  const discoveryEntryPluginIds = new Set(
    loadPluginManifestRegistry({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
    }).plugins.flatMap((plugin) =>
      plugin.origin === "bundled" && plugin.providerDiscoverySource ? [plugin.id] : [],
    ),
  );
  const pluginIds = resolveBundledProviderCompatPluginIds({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env,
  }).filter((pluginId) => discoveryEntryPluginIds.has(pluginId));
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
      });
      pluginCatalogs.set(catalogKey, catalog);
    }
    return ((await catalog).get(provider) ?? []).find((candidate) =>
      staticModelIdMatches({
        candidateId: candidate.id,
        provider,
        modelId: lookup.modelId,
      }),
    );
  };
}

/**
 * Prepares bundled provider static-catalog lookup.
 * Each provider hook runs at most once for the resolver lifetime.
 */
export function createBundledProviderStaticCatalogModelResolver(
  params: BundledProviderStaticCatalogResolverParams = {},
): (lookup: BundledStaticCatalogLookup) => Promise<ProviderRuntimeModel | undefined> {
  const resolveModel = createScopedBundledProviderStaticCatalogModelResolver(params);
  return async (lookup) => await resolveModel(lookup);
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
      ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
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
}): Promise<ProviderRuntimeModel | undefined> {
  return createBundledProviderStaticCatalogModelResolver(params)(params);
}
