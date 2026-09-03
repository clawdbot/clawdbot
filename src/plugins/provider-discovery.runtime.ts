// Runtime boundary for provider discovery through plugin entrypoints.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { sortUniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { withProfile } from "./plugin-load-profile.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { getCachedPluginModuleLoader, preparePluginModule } from "./plugin-module-loader-cache.js";
import { resolvePluginRuntimeArtifact } from "./plugin-runtime-artifact-resolution.js";
import {
  prefersBuiltPluginArtifacts,
  resolvePluginRuntimeArtifactPreference,
} from "./plugin-runtime-artifact-selection.js";
import { buildEffectiveManifestProviderConfig } from "./provider-catalog.js";
import type {
  ProviderDiscoveryPlan,
  ResolveRuntimePluginDiscoveryProvidersParams,
} from "./provider-discovery.js";
import { resolveDiscoveredProviderPluginIds } from "./providers.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";
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
  runtimeManifestCatalogPluginIds: Set<string>;
};

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

function loadProviderDiscoveryModule(manifest: PluginManifestRecord): ProviderDiscoveryModule {
  const registry = getPluginRuntimeGenerationRegistry();
  const loadContext = getPluginRuntimeLoadContext(registry);
  // Lightweight entries share the prepared registry's artifact policy, but must
  // not alias its runtime entry or turn standalone source discovery into a build load.
  const { source, rootDir } = registry
    ? resolvePluginRuntimeArtifact({
        pluginId: manifest.id,
        entryKind: "provider-discovery",
        source: manifest.providerDiscoverySource!,
        rootDir: manifest.rootDir,
        origin: manifest.origin,
        packageManifest: manifest.packageManifest,
        preferBuiltPluginArtifacts: prefersBuiltPluginArtifacts(
          resolvePluginRuntimeArtifactPreference(loadContext?.preferBuiltPluginArtifacts),
          manifest.origin,
        ),
        sourcePreferred: manifest.sourcePreferred,
        registry,
      })
    : { source: manifest.providerDiscoverySource!, rootDir: manifest.rootDir };
  const modulePath = registry
    ? preparePluginModule({
        modulePath: source,
        boundaryRoot: rootDir,
        boundaryLabel: "plugin root",
        surfaceLabel: `plugin provider discovery ${manifest.id}`,
        rejectHardlinks: shouldRejectHardlinkedPluginFiles({
          origin: manifest.origin,
          rootDir: manifest.rootDir,
          env: loadContext?.env,
        }),
      }).modulePath
    : source;
  const moduleLoader = getCachedPluginModuleLoader({
    modulePath,
    rootDir,
    importerUrl: import.meta.url,
    loaderFilename: import.meta.url,
    preferBuiltDist: true,
  });
  return withProfile(
    { pluginId: manifest.id, source: modulePath },
    "provider-discovery-entry",
    () => moduleLoader(modulePath) as ProviderDiscoveryModule,
  );
}

function hasLiveProviderDiscoveryHook(provider: ProviderPlugin): boolean {
  return typeof provider.catalog?.run === "function";
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
  const envVars = (plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []);
  return envVars.some((name) => {
    const value = env[name]?.trim();
    return value !== undefined && value !== "";
  });
}

function prepareManifestCatalogDiscovery(
  pluginRecords: readonly PluginManifestRecord[],
  config: OpenClawConfig,
  includeProviders: boolean,
): Pick<ProviderDiscoveryEntryResult, "providers" | "runtimeManifestCatalogPluginIds"> {
  const providers: ProviderPlugin[] = [];
  const runtimeManifestCatalogPluginIds = new Set<string>();
  for (const plugin of pluginRecords) {
    if (!plugin.modelCatalog) {
      continue;
    }
    const ownedProviders = new Set(
      plugin.providers.map((provider) => normalizeProviderId(provider)),
    );
    if (
      Object.entries(plugin.modelCatalog.discovery ?? {}).some(
        ([provider, discovery]) =>
          (discovery === "runtime" || discovery === "refreshable") &&
          ownedProviders.has(normalizeProviderId(provider)),
      )
    ) {
      runtimeManifestCatalogPluginIds.add(plugin.id);
    }
    if (!plugin.modelCatalog.providers) {
      continue;
    }
    // Static rows and runtime coverage must come from the same effective catalog.
    const plan = planEffectiveModelCatalogRows({ registry: { plugins: [plugin] }, config });
    for (const entry of plan.entries) {
      if (entry.discovery === "runtime" || entry.discovery === "refreshable") {
        runtimeManifestCatalogPluginIds.add(plugin.id);
      }
      if (!includeProviders || entry.rows.length === 0) {
        continue;
      }
      const providerConfig = buildEffectiveManifestProviderConfig(entry.rows);
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
  return { providers, runtimeManifestCatalogPluginIds };
}

function resolveProviderDiscoveryEntryPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  discoveryEntriesOnly?: boolean;
  includeManifestModelCatalogProviders?: boolean;
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
  const { providers: manifestProviders, runtimeManifestCatalogPluginIds } =
    prepareManifestCatalogDiscovery(
      pluginRecords,
      params.config ?? {},
      params.includeManifestModelCatalogProviders !== false,
    );
  const entryRecords = pluginRecords.filter((plugin) => plugin.providerDiscoverySource);
  const entryPluginIds = new Set(entryRecords.map((plugin) => plugin.id));
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
  const result = {
    providers: manifestProviders,
    complete,
    pluginRecords,
    entryPluginIds,
    runtimeManifestCatalogPluginIds,
  };
  if (entryRecords.length === 0) {
    return result;
  }
  const providers: ProviderPlugin[] = [];
  for (const manifest of entryRecords) {
    try {
      const moduleExport = loadProviderDiscoveryModule(manifest);
      providers.push(
        ...normalizeDiscoveryModule(moduleExport).map((provider) =>
          Object.assign({}, provider, { pluginId: manifest.id }),
        ),
      );
    } catch {
      // Entry loading is all-or-nothing: discarded results no longer cover their owners.
      // Keep static manifest coverage for the scope-aware full-loader fallback.
      return { ...result, complete: false, entryPluginIds: manifestEntryPluginIds };
    }
  }
  return { ...result, providers: [...manifestProviders, ...providers] };
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

export function planPluginDiscoveryRuntime(
  params: ResolveRuntimePluginDiscoveryProvidersParams,
): ProviderDiscoveryPlan {
  const env = params.env ?? process.env;
  const entryResult = resolveProviderDiscoveryEntryPlugins({ ...params, env });
  const entryProviders = entryResult.providers.filter(
    (provider) =>
      hasProviderCatalogHook(provider) ||
      (params.includeSyntheticAuthProviders === true &&
        typeof provider.resolveSyntheticAuth === "function"),
  );
  const runtimeEntryProviders = resolveRuntimeEntryProviders(entryResult);
  if (params.discoveryEntriesOnly === true) {
    return { kind: "entries", providers: entryProviders };
  }
  if (
    entryResult.providers.length > 0 &&
    entryResult.complete &&
    runtimeEntryProviders.length === entryResult.providers.length &&
    entryResult.runtimeManifestCatalogPluginIds.size === 0
  ) {
    return { kind: "entries", providers: runtimeEntryProviders };
  }
  let fullPluginIds = params.onlyPluginIds;
  let retainedProviders: ProviderPlugin[] | undefined;
  if (runtimeEntryProviders.length > 0 || entryResult.runtimeManifestCatalogPluginIds.size > 0) {
    // Runtime manifest owners do not cover siblings without discovery entries.
    // Preserve the selected scope; unscoped discovery stays credential-bounded.
    fullPluginIds = sortUniqueStrings([
      ...entryResult.pluginRecords
        .filter(
          (plugin) =>
            !entryResult.entryPluginIds.has(plugin.id) &&
            (params.onlyPluginIds !== undefined || hasProviderAuthEnvCredential(plugin, env)),
        )
        .map((plugin) => plugin.id),
      ...entryResult.runtimeManifestCatalogPluginIds,
    ]);
    if (fullPluginIds.length === 0) {
      return { kind: "entries", providers: runtimeEntryProviders };
    }
    const fullPluginIdSet = new Set(fullPluginIds);
    retainedProviders = runtimeEntryProviders.filter(
      (provider) => !provider.pluginId || !fullPluginIdSet.has(provider.pluginId),
    );
  } else if (entryProviders.length > 0) {
    const entryPluginIds = sortUniqueStrings(
      entryProviders
        .map((provider) => provider.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== ""),
    );
    if (entryPluginIds.length > 0) {
      fullPluginIds = entryPluginIds;
    }
  }
  return { kind: "runtime", providers: retainedProviders ?? [], pluginIds: fullPluginIds };
}

export function resolvePluginDiscoveryProvidersRuntime(
  params: ResolveRuntimePluginDiscoveryProvidersParams,
): ProviderPlugin[] {
  const plan = planPluginDiscoveryRuntime(params);
  if (plan.kind === "entries") {
    return plan.providers;
  }
  const fullProviders = resolvePluginProvidersCore({
    ...params,
    env: params.env ?? process.env,
    ...(plan.pluginIds ? { onlyPluginIds: plan.pluginIds } : {}),
  });
  return [...plan.providers, ...fullProviders];
}
