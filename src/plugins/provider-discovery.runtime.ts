import path from "node:path";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planManifestModelCatalogRows } from "../model-catalog/manifest-planner.js";
import { sortUniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { clearNativeRequireJavaScriptModuleCache } from "./native-module-require.js";
import { withProfile } from "./plugin-load-profile.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";
import { resolveDiscoveredProviderPluginIds } from "./providers.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import type { ProviderPlugin } from "./types.js";

type ProviderDiscoveryModule =
  | ProviderPlugin
  | ProviderPlugin[]
  | {
      default?: ProviderPlugin | ProviderPlugin[];
      providers?: ProviderPlugin[];
      provider?: ProviderPlugin;
    };

type ProviderDiscoveryEntryResult = {
  providers: ProviderPlugin[];
  complete: boolean;
  pluginRecords: PluginManifestRecord[];
  entryPluginIds: Set<string>;
  manifestEntryPluginIds: Set<string>;
  runtimeManifestCatalogPluginIds: Set<string>;
};

const providerDiscoveryModuleLoaders = createPluginModuleLoaderCache();
const providerDiscoveryModuleRoots = new Map<string, string>();

function resolveProviderDiscoveryDependencyRoot(rootDir: string): string {
  const extensionsDir = path.dirname(rootDir);
  const distDir = path.dirname(extensionsDir);
  // Bundled dist provider entries import hoisted dist/*.js chunks outside
  // dist/extensions/<plugin>; lifecycle clears must evict those chunks too.
  if (path.basename(extensionsDir) === "extensions" && path.basename(distDir) === "dist") {
    return distDir;
  }
  return rootDir;
}

export function clearProviderDiscoveryModuleLoaders(): void {
  providerDiscoveryModuleLoaders.clear();
  for (const [modulePath, rootDir] of providerDiscoveryModuleRoots) {
    clearNativeRequireJavaScriptModuleCache(modulePath, { dependencyRoot: rootDir });
  }
  providerDiscoveryModuleRoots.clear();
}

registerPluginMetadataProcessMemoLifecycleClear(clearProviderDiscoveryModuleLoaders);

function normalizeDiscoveryModule(value: ProviderDiscoveryModule): ProviderPlugin[] {
  const resolved =
    value && typeof value === "object" && "default" in value && value.default !== undefined
      ? value.default
      : value;
  if (Array.isArray(resolved)) {
    return resolved;
  }
  if (resolved && typeof resolved === "object" && "id" in resolved) {
    return [resolved];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { providers?: ProviderPlugin[]; provider?: ProviderPlugin };
    if (Array.isArray(record.providers)) {
      return record.providers;
    }
    if (record.provider) {
      return [record.provider];
    }
  }
  return [];
}

function loadProviderDiscoveryModule(params: {
  pluginId: string;
  modulePath: string;
  rootDir: string;
}): ProviderDiscoveryModule {
  providerDiscoveryModuleRoots.set(
    params.modulePath,
    resolveProviderDiscoveryDependencyRoot(params.rootDir),
  );
  const moduleLoader = getCachedPluginModuleLoader({
    cache: providerDiscoveryModuleLoaders,
    modulePath: params.modulePath,
    importerUrl: import.meta.url,
    loaderFilename: import.meta.url,
    preferBuiltDist: true,
  });
  return withProfile(
    { pluginId: params.pluginId, source: params.modulePath },
    "provider-discovery-entry",
    () => moduleLoader(params.modulePath) as ProviderDiscoveryModule,
  );
}

function hasLiveProviderDiscoveryHook(provider: ProviderPlugin): boolean {
  return (
    typeof provider.catalog?.run === "function" || typeof provider.discovery?.run === "function"
  );
}

function hasProviderCatalogHook(provider: ProviderPlugin): boolean {
  return (
    hasLiveProviderDiscoveryHook(provider) || typeof provider.staticCatalog?.run === "function"
  );
}

function hasProviderAuthEnvCredential(
  plugin: PluginManifestRecord,
  env: NodeJS.ProcessEnv,
): boolean {
  const envVars = [
    ...(plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []),
    ...Object.values(plugin.providerAuthEnvVars ?? {}).flat(),
  ];
  return envVars.some((name) => {
    const value = env[name]?.trim();
    return value !== undefined && value !== "";
  });
}

function modelDefinitionCostFromManifestRow(
  row: NormalizedModelCatalogRow,
): ModelDefinitionConfig["cost"] {
  if (
    !row.cost ||
    row.cost.input === undefined ||
    row.cost.output === undefined ||
    row.cost.cacheRead === undefined ||
    row.cost.cacheWrite === undefined
  ) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }
  return {
    input: row.cost.input,
    output: row.cost.output,
    cacheRead: row.cost.cacheRead,
    cacheWrite: row.cost.cacheWrite,
    ...(row.cost.tieredPricing ? { tieredPricing: row.cost.tieredPricing } : {}),
  };
}

function modelDefinitionFromManifestRow(
  row: NormalizedModelCatalogRow,
): ModelDefinitionConfig | undefined {
  const cost = modelDefinitionCostFromManifestRow(row);
  if (!row.contextWindow || !row.maxTokens) {
    return undefined;
  }
  const input: ModelDefinitionConfig["input"] = row.input.filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  return {
    id: row.id,
    name: row.name || row.id,
    ...(row.api ? { api: row.api } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    reasoning: row.reasoning,
    input,
    cost,
    contextWindow: row.contextWindow,
    ...(row.contextTokens ? { contextTokens: row.contextTokens } : {}),
    maxTokens: row.maxTokens,
    ...(row.headers ? { headers: row.headers } : {}),
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.mediaInput ? { mediaInput: row.mediaInput } : {}),
  };
}

function providerConfigFromManifestRows(
  rows: readonly NormalizedModelCatalogRow[],
): ModelProviderConfig | undefined {
  const firstRow = rows[0];
  if (!firstRow?.baseUrl || !firstRow.api) {
    return undefined;
  }
  const models = rows
    .map((row) => modelDefinitionFromManifestRow(row))
    .filter((model): model is ModelDefinitionConfig => Boolean(model));
  if (models.length === 0) {
    return undefined;
  }
  return {
    baseUrl: firstRow?.baseUrl ?? "",
    ...(firstRow?.api ? { api: firstRow.api } : {}),
    models,
  };
}

function resolveManifestModelCatalogProviders(
  pluginRecords: readonly PluginManifestRecord[],
): ProviderPlugin[] {
  const providers: ProviderPlugin[] = [];
  for (const plugin of pluginRecords) {
    if (!plugin.modelCatalog?.providers) {
      continue;
    }
    const plan = planManifestModelCatalogRows({ registry: { plugins: [plugin] } });
    for (const entry of plan.entries) {
      if (entry.rows.length === 0 || entry.discovery === "runtime") {
        continue;
      }
      const providerConfig = providerConfigFromManifestRows(entry.rows);
      if (!providerConfig) {
        continue;
      }
      providers.push({
        id: entry.provider,
        pluginId: plugin.id,
        label: entry.provider,
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({ providers: { [entry.provider]: providerConfig } }),
        },
      });
    }
  }
  return providers;
}

function resolveRuntimeManifestCatalogPluginIds(
  pluginRecords: readonly PluginManifestRecord[],
): Set<string> {
  const pluginIds = new Set<string>();
  for (const plugin of pluginRecords) {
    const ownedProviders = new Set(
      plugin.providers.map((provider) => normalizeProviderId(provider)),
    );
    const ownsRuntimeDiscovery = Object.entries(plugin.modelCatalog?.discovery ?? {}).some(
      ([provider, discovery]) =>
        discovery === "runtime" && ownedProviders.has(normalizeProviderId(provider)),
    );
    if (ownsRuntimeDiscovery) {
      pluginIds.add(plugin.id);
    }

    if (!plugin.modelCatalog?.providers) {
      continue;
    }
    const plan = planManifestModelCatalogRows({ registry: { plugins: [plugin] } });
    if (plan.entries.some((entry) => entry.discovery === "runtime")) {
      pluginIds.add(plugin.id);
    }
  }
  return pluginIds;
}

function resolveProviderDiscoveryEntryPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderDiscoveryEntryResult {
  const metadataSnapshot =
    params.pluginMetadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.config ?? {},
      env: params.env ?? process.env,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  const registry = metadataSnapshot.index;
  const manifestRegistry = metadataSnapshot.manifestRegistry;
  const pluginIds = resolveDiscoveredProviderPluginIds({
    ...params,
    registry,
    manifestRegistry,
  });
  const pluginIdSet = new Set(pluginIds);
  const pluginRecords = manifestRegistry.plugins.filter((plugin) => pluginIdSet.has(plugin.id));
  const runtimeManifestCatalogPluginIds = resolveRuntimeManifestCatalogPluginIds(pluginRecords);
  const entryRecords = pluginRecords.filter((plugin) => plugin.providerDiscoverySource);
  const entryPluginIds = new Set(entryRecords.map((plugin) => plugin.id));
  const manifestProviders = resolveManifestModelCatalogProviders(pluginRecords);
  const manifestEntryPluginIds = new Set<string>();
  for (const pluginId of manifestProviders.map((provider) => provider.pluginId)) {
    if (pluginId) {
      manifestEntryPluginIds.add(pluginId);
      // Mixed static/runtime catalogs are useful for entries-only discovery, but
      // they are not complete coverage; the runtime plugin must fill the rest.
      if (!runtimeManifestCatalogPluginIds.has(pluginId)) {
        entryPluginIds.add(pluginId);
      }
    }
  }
  const complete = entryPluginIds.size === pluginIdSet.size;
  const entriesOnlyComplete =
    new Set([...entryPluginIds, ...manifestEntryPluginIds]).size === pluginIdSet.size;
  if (entryRecords.length === 0) {
    return {
      providers: manifestProviders,
      complete,
      pluginRecords,
      entryPluginIds,
      manifestEntryPluginIds,
      runtimeManifestCatalogPluginIds,
    };
  }
  if (
    params.requireCompleteDiscoveryEntryCoverage &&
    !(params.discoveryEntriesOnly === true ? entriesOnlyComplete : complete)
  ) {
    return {
      providers: [],
      complete: false,
      pluginRecords,
      entryPluginIds,
      manifestEntryPluginIds,
      runtimeManifestCatalogPluginIds,
    };
  }
  const providers: ProviderPlugin[] = [];
  for (const manifest of entryRecords) {
    try {
      const moduleExport = loadProviderDiscoveryModule({
        pluginId: manifest.id,
        modulePath: manifest.providerDiscoverySource!,
        rootDir: manifest.rootDir,
      });
      providers.push(
        ...normalizeDiscoveryModule(moduleExport).map((provider) =>
          Object.assign({}, provider, { pluginId: manifest.id }),
        ),
      );
    } catch {
      // Discovery fast path is optional. Fall back to the full plugin loader
      // below so existing plugin diagnostics/load behavior remains canonical.
      return {
        providers: manifestProviders,
        complete: false,
        pluginRecords,
        entryPluginIds,
        manifestEntryPluginIds,
        runtimeManifestCatalogPluginIds,
      };
    }
  }
  return {
    providers: [...manifestProviders, ...providers],
    complete,
    pluginRecords,
    entryPluginIds,
    manifestEntryPluginIds,
    runtimeManifestCatalogPluginIds,
  };
}

function resolveSelectiveFullPluginIds(params: {
  entryResult: ProviderDiscoveryEntryResult;
  env: NodeJS.ProcessEnv;
}): string[] {
  const missingEntryCredentialPluginIds = params.entryResult.pluginRecords
    .filter((plugin) => !params.entryResult.entryPluginIds.has(plugin.id))
    .filter((plugin) => hasProviderAuthEnvCredential(plugin, params.env))
    .map((plugin) => plugin.id);
  const runtimeManifestCatalogPluginIds = listRuntimeManifestCatalogPluginIds(params.entryResult);
  return sortUniqueStrings([
    ...missingEntryCredentialPluginIds,
    ...runtimeManifestCatalogPluginIds,
  ]);
}

function listRuntimeManifestCatalogPluginIds(entryResult: ProviderDiscoveryEntryResult): string[] {
  return [...entryResult.runtimeManifestCatalogPluginIds];
}

function resolveMissingEntryPluginIds(entryResult: ProviderDiscoveryEntryResult): string[] {
  return entryResult.pluginRecords
    .filter((plugin) => !entryResult.entryPluginIds.has(plugin.id))
    .map((plugin) => plugin.id);
}

function resolveRuntimeEntryProviders(entryResult: ProviderDiscoveryEntryResult): ProviderPlugin[] {
  return entryResult.providers.filter((provider) => {
    if (hasLiveProviderDiscoveryHook(provider)) {
      return true;
    }
    return Boolean(
      provider.pluginId &&
      entryResult.entryPluginIds.has(provider.pluginId) &&
      typeof provider.staticCatalog?.run === "function",
    );
  });
}

function withoutFullLoadedPluginEntries(
  providers: ProviderPlugin[],
  pluginIds: readonly string[],
): ProviderPlugin[] {
  if (pluginIds.length === 0) {
    return providers;
  }
  const pluginIdSet = new Set(pluginIds);
  return providers.filter((provider) => !provider.pluginId || !pluginIdSet.has(provider.pluginId));
}

export function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const bundledProviderVitestCompat = params.bundledProviderVitestCompat ?? env.VITEST === "true";
  const entryResult = resolveProviderDiscoveryEntryPlugins({ ...params, env });
  const entryProviders = entryResult.providers.filter(hasProviderCatalogHook);
  const runtimeEntryProviders = resolveRuntimeEntryProviders(entryResult);
  if (params.discoveryEntriesOnly === true) {
    return entryProviders;
  }
  if (
    entryResult.providers.length > 0 &&
    entryResult.complete &&
    runtimeEntryProviders.length === entryResult.providers.length &&
    entryResult.runtimeManifestCatalogPluginIds.size === 0
  ) {
    return runtimeEntryProviders;
  }
  if (params.onlyPluginIds === undefined && runtimeEntryProviders.length > 0) {
    const fullPluginIds = resolveSelectiveFullPluginIds({
      entryResult,
      env,
    });
    const fullProviders =
      fullPluginIds.length > 0
        ? resolvePluginProviders({
            ...params,
            env,
            bundledProviderVitestCompat,
            onlyPluginIds: fullPluginIds,
          })
        : [];
    return [
      ...withoutFullLoadedPluginEntries(runtimeEntryProviders, fullPluginIds),
      ...fullProviders,
    ];
  }
  if (runtimeEntryProviders.length > 0) {
    const fullPluginIds = sortUniqueStrings([
      ...resolveMissingEntryPluginIds(entryResult),
      ...listRuntimeManifestCatalogPluginIds(entryResult),
    ]);
    const fullProviders =
      fullPluginIds.length > 0
        ? resolvePluginProviders({
            ...params,
            env,
            bundledProviderVitestCompat,
            onlyPluginIds: fullPluginIds,
          })
        : [];
    return [
      ...withoutFullLoadedPluginEntries(runtimeEntryProviders, fullPluginIds),
      ...fullProviders,
    ];
  }
  const runtimeManifestCatalogPluginIds = listRuntimeManifestCatalogPluginIds(entryResult);
  if (runtimeManifestCatalogPluginIds.length > 0) {
    return resolvePluginProviders({
      ...params,
      env,
      bundledProviderVitestCompat,
      onlyPluginIds: runtimeManifestCatalogPluginIds,
    });
  }
  if (entryProviders.length > 0) {
    const fullPluginIds = sortUniqueStrings(
      entryProviders
        .map((provider) => provider.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== ""),
    );
    if (fullPluginIds.length > 0) {
      return resolvePluginProviders({
        ...params,
        env,
        bundledProviderVitestCompat,
        onlyPluginIds: fullPluginIds,
      });
    }
  }
  return resolvePluginProviders({
    ...params,
    env,
    bundledProviderVitestCompat,
  });
}
