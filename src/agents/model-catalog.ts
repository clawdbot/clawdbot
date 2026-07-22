/**
 * Loads bundled, manifest, and discovered model catalog entries.
 */
import { resolveClaudeFable5ModelIdentity } from "@openclaw/llm-core";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { planManifestModelCatalogRows } from "../model-catalog/manifest-planner.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { modelSupportsInput as modelCatalogEntrySupportsInput } from "./model-catalog-lookup.js";
import type {
  ModelCatalogEntry,
  ModelCatalogSnapshot,
  ModelInputType,
} from "./model-catalog.types.js";
import { resolveCatalogOwnedModelCompat } from "./model-compat-catalog.js";
import {
  modelKey,
  normalizeConfiguredProviderCatalogModelId,
  type ProviderModelIdNormalizationOptions,
} from "./model-ref-shared.js";
import {
  buildConfiguredModelCatalog,
  hasConfiguredProviderModelRows,
} from "./model-selection-shared.js";
import type { AuthStorageData, ModelRegistry } from "./sessions/index.js";

const log = createSubsystemLogger("model-catalog");

export type {
  ModelCatalogEntry,
  ModelCatalogSnapshot,
  ModelInputType,
} from "./model-catalog.types.js";
export {
  findModelCatalogEntry,
  findModelInCatalog,
  modelSupportsInput,
} from "./model-catalog-lookup.js";

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  api?: ModelCatalogEntry["api"];
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  params?: ModelCatalogEntry["params"];
  compat?: ModelCatalogEntry["compat"];
  baseUrl?: string;
};

export type BuildPreparedModelCatalogParams = {
  agentDir: string;
  authCredentials: Readonly<AuthStorageData>;
  config: OpenClawConfig;
  modelRegistry: ModelRegistry;
  readOnly?: boolean;
  includeProviderPluginAugmentation?: boolean;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

let hasLoggedModelCatalogError = false;
type ManifestModelCatalogCacheEntry = {
  snapshot: PluginMetadataSnapshot;
  rows: ModelCatalogEntry[];
};
let manifestModelCatalogCache = new WeakMap<OpenClawConfig, ManifestModelCatalogCacheEntry>();
const modelSuppressionLoader = createLazyImportLoader(
  () => import("./model-suppression.runtime.js"),
);
const providerApiKeyResolverLoader = createLazyImportLoader(
  () => import("./models-config.providers.secrets.js"),
);

function loadModelSuppression() {
  return modelSuppressionLoader.load();
}

function loadProviderApiKeyResolver() {
  return providerApiKeyResolverLoader.load();
}

export function resetModelCatalogBuilderCacheForTest() {
  manifestModelCatalogCache = new WeakMap();
  hasLoggedModelCatalogError = false;
}

/** Canonicalizes a provider alias against the metadata captured with a prepared catalog. */
export function canonicalizePreparedModelCatalogProvider(
  provider: string,
  metadataSnapshot: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): string {
  const normalizedProvider = normalizeProviderId(provider);
  for (const plugin of metadataSnapshot.manifestRegistry.plugins) {
    for (const [alias, target] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      if (normalizeProviderId(alias) === normalizedProvider) {
        const canonicalProvider = normalizeProviderId(target.provider);
        if (canonicalProvider) {
          return canonicalProvider;
        }
      }
    }
  }
  return normalizedProvider;
}

function catalogEntryDedupeKey(provider: string, id: string): string {
  const normalizedProvider = normalizeProviderId(provider);
  return normalizeLowercaseStringOrEmpty(modelKey(normalizedProvider, id));
}

function mergeCatalogCompat(
  base: ModelCatalogEntry["compat"] | undefined,
  override: ModelCatalogEntry["compat"] | undefined,
): ModelCatalogEntry["compat"] | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return { ...base, ...override };
}

function mergeCatalogParams(
  base: ModelCatalogEntry["params"] | undefined,
  override: ModelCatalogEntry["params"] | undefined,
): ModelCatalogEntry["params"] | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return { ...base, ...override };
}

function normalizeCatalogRouteBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

function catalogRouteChanges(base: ModelCatalogEntry, overlay: ModelCatalogEntry): boolean {
  if (overlay.api === undefined && overlay.baseUrl === undefined) {
    return false;
  }
  return (
    (overlay.api !== undefined && base.api !== undefined && overlay.api !== base.api) ||
    (overlay.baseUrl !== undefined &&
      base.baseUrl !== undefined &&
      normalizeCatalogRouteBaseUrl(overlay.baseUrl) !== normalizeCatalogRouteBaseUrl(base.baseUrl))
  );
}

function clearRouteBoundCatalogMetadata(entry: ModelCatalogEntry): ModelCatalogEntry {
  const {
    contextWindow: _contextWindow,
    contextTokens: _contextTokens,
    reasoning: _reasoning,
    input: _input,
    params: _params,
    compat: _compat,
    mediaInput: _mediaInput,
    ...routeNeutral
  } = entry;
  return routeNeutral;
}

function overlayCatalogMetadata(
  base: ModelCatalogEntry,
  overlay: ModelCatalogEntry,
  options?: {
    catalogCompatRoute?: ModelCatalogEntry;
    preserveBaseCompat?: boolean;
    preserveBaseName?: boolean;
  },
): ModelCatalogEntry {
  // Catalog rows with one logical provider/id may describe different physical
  // routes. Capabilities are atomic with their route; never carry them across
  // an API/endpoint change when the new source omits those facts.
  const routeChanged = catalogRouteChanges(base, overlay);
  const routeBase = routeChanged ? clearRouteBoundCatalogMetadata(base) : base;
  const params = mergeCatalogParams(routeBase.params, overlay.params);
  return {
    ...routeBase,
    ...(routeChanged && !options?.preserveBaseName ? { name: overlay.name } : {}),
    ...(overlay.api !== undefined ? { api: overlay.api } : {}),
    ...(overlay.baseUrl !== undefined ? { baseUrl: overlay.baseUrl } : {}),
    ...(overlay.contextWindow !== undefined ? { contextWindow: overlay.contextWindow } : {}),
    ...(overlay.contextTokens !== undefined ? { contextTokens: overlay.contextTokens } : {}),
    ...(overlay.reasoning !== undefined ? { reasoning: overlay.reasoning } : {}),
    ...(overlay.input !== undefined ? { input: overlay.input } : {}),
    ...(params ? { params } : {}),
    ...(overlay.mediaInput !== undefined ? { mediaInput: overlay.mediaInput } : {}),
    compat: options?.preserveBaseCompat
      ? resolveCatalogOwnedModelCompat({
          catalogRoute: options.catalogCompatRoute ?? base,
          catalogCompat: (options.catalogCompatRoute ?? base).compat,
          configuredRoute: {
            api: overlay.api ?? base.api,
            baseUrl: overlay.baseUrl ?? base.baseUrl,
          },
          configuredCompat: overlay.compat,
        })
      : mergeCatalogCompat(routeBase.compat, overlay.compat),
  };
}

function normalizeCatalogEntryContract(entry: ModelCatalogEntry): ModelCatalogEntry {
  if (
    entry.api === "anthropic-messages" &&
    resolveClaudeFable5ModelIdentity({ id: entry.id, params: entry.params })
  ) {
    return { ...entry, reasoning: true };
  }
  return entry;
}

function mergeCatalogEntries(
  models: ModelCatalogEntry[],
  entries: ModelCatalogEntry[],
  options?: {
    catalogCompatRoutes?: readonly ModelCatalogEntry[];
    preserveBaseCompat?: boolean;
    preserveBaseName?: boolean;
  },
): void {
  const indexByKey = new Map(
    models.map((entry, index) => [catalogEntryDedupeKey(entry.provider, entry.id), index]),
  );
  for (const entry of entries) {
    const key = catalogEntryDedupeKey(entry.provider, entry.id);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      models.push(entry);
      indexByKey.set(key, models.length - 1);
      continue;
    }
    const existing = models.at(existingIndex);
    if (existing) {
      // The logical row may currently represent a sibling physical route. Compat
      // must come from the catalog variant selected by config, not that sibling.
      const catalogCompatRoute = options?.preserveBaseCompat
        ? options.catalogCompatRoutes?.find(
            (candidate) => catalogRouteVariantKey(candidate) === catalogRouteVariantKey(entry),
          )
        : undefined;
      models[existingIndex] = overlayCatalogMetadata(existing, entry, {
        ...options,
        catalogCompatRoute,
      });
    }
  }
}

function catalogRouteVariantKey(entry: ModelCatalogEntry): string {
  return [
    catalogEntryDedupeKey(entry.provider, entry.id),
    entry.api ?? "",
    normalizeCatalogRouteBaseUrl(entry.baseUrl) ?? "",
  ].join("\u0000");
}

type ModelCatalogRouteVariantCollector = {
  entries: ModelCatalogEntry[];
  indexByKey: Map<string, number>;
};

function createModelCatalogRouteVariantCollector(): ModelCatalogRouteVariantCollector {
  return { entries: [], indexByKey: new Map() };
}

function mergeCatalogRouteVariants(
  collector: ModelCatalogRouteVariantCollector,
  entries: readonly ModelCatalogEntry[],
  options?: { preserveBaseCompat?: boolean },
): void {
  for (const entry of entries) {
    const key = catalogRouteVariantKey(entry);
    const existingIndex = collector.indexByKey.get(key);
    if (existingIndex === undefined) {
      collector.entries.push(entry);
      collector.indexByKey.set(key, collector.entries.length - 1);
      continue;
    }
    const existingEntry = collector.entries[existingIndex];
    if (existingEntry === undefined) {
      continue;
    }
    collector.entries[existingIndex] = overlayCatalogMetadata(existingEntry, entry, options);
  }
}

function createModelCatalogSnapshot(
  entries: ModelCatalogEntry[],
  routeVariants: ModelCatalogRouteVariantCollector,
): ModelCatalogSnapshot {
  return {
    entries: sortModelCatalogEntries(entries),
    routeVariants: sortModelCatalogEntries(routeVariants.entries),
  };
}

export function loadManifestModelCatalog(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  fallbackToMetadataScan?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ModelCatalogEntry[] {
  const resolvedSnapshot =
    params.metadataSnapshot ??
    (params.fallbackToMetadataScan === false
      ? getCurrentPluginMetadataSnapshot({
          config: params.config,
          env: params.env,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.workspaceDir === undefined ? { allowWorkspaceScopedSnapshot: true } : {}),
        })
      : resolvePluginMetadataSnapshot({
          config: params.config,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          env: params.env ?? process.env,
          allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
        }));
  if (!resolvedSnapshot) {
    return [];
  }
  const cached = manifestModelCatalogCache.get(params.config);
  if (cached?.snapshot === resolvedSnapshot) {
    return cached.rows;
  }
  const eligiblePlugins = resolvedSnapshot.plugins.filter(
    (plugin) =>
      plugin.modelCatalog &&
      isManifestPluginAvailableForControlPlane({
        snapshot: resolvedSnapshot,
        plugin,
        config: params.config,
      }),
  );
  const plan = planManifestModelCatalogRows({
    registry: { plugins: eligiblePlugins },
  });
  const rows = plan.rows.map((row) => {
    const entry: ModelCatalogEntry = {
      id: row.id,
      name: row.name,
      provider: row.provider,
      api: row.api,
    };
    if (row.baseUrl) {
      entry.baseUrl = row.baseUrl;
    }
    const contextWindow = row.contextWindow ?? row.contextTokens;
    if (contextWindow) {
      entry.contextWindow = contextWindow;
    }
    if (row.contextTokens) {
      entry.contextTokens = row.contextTokens;
    }
    if (typeof row.reasoning === "boolean") {
      entry.reasoning = row.reasoning;
    }
    if (row.input?.length) {
      entry.input = [...row.input];
    }
    if (row.compat) {
      entry.compat = row.compat;
    }
    return entry;
  });
  manifestModelCatalogCache.set(params.config, { snapshot: resolvedSnapshot, rows });
  return rows;
}

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.map(normalizeCatalogEntryContract).toSorted((a, b) => {
    const p = a.provider.localeCompare(b.provider);
    if (p !== 0) {
      return p;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Builds the catalog once for a lifecycle generation. No request-time discovery or cache IO. */
export async function buildPreparedModelCatalogSnapshot(
  params: BuildPreparedModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const models: ModelCatalogEntry[] = [];
  const routeVariants = createModelCatalogRouteVariantCollector();
  const cfg = params.config;
  const env = params.env ?? process.env;
  const timingEnabled = isDiagnosticFlagEnabled("ingress.timing", cfg);
  const startMs = timingEnabled ? Date.now() : 0;
  const logStage = (stage: string, extra?: string) => {
    if (!timingEnabled) {
      return;
    }
    const suffix = extra ? ` ${extra}` : "";
    log.info(`model-catalog stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
  };
  try {
    const workspaceDir = params.workspaceDir;
    const manifestMetadataSnapshot = params.metadataSnapshot;
    let manifestPlugins: ProviderModelIdNormalizationOptions["manifestPlugins"];
    const getManifestPlugins = () => {
      manifestPlugins ??= manifestMetadataSnapshot.plugins;
      return manifestPlugins;
    };
    const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
    logStage("catalog-deps-ready");
    const entries = params.modelRegistry.getAll() as DiscoveredModel[];
    logStage("registry-read", `entries=${entries.length}`);

    const shouldSuppressBuiltInModel = buildShouldSuppressBuiltInModel({ config: cfg });
    logStage("suppress-resolver-ready");

    for (const entry of entries) {
      const rawId = normalizeOptionalString(entry?.id) ?? "";
      if (!rawId) {
        continue;
      }
      const provider = normalizeOptionalString(entry?.provider) ?? "";
      if (!provider) {
        continue;
      }
      const id = normalizeConfiguredProviderCatalogModelId(provider, rawId, {
        manifestPlugins: getManifestPlugins(),
      });
      const baseUrl = normalizeOptionalString(entry?.baseUrl);
      if (shouldSuppressBuiltInModel({ provider, id, baseUrl })) {
        continue;
      }
      const name = normalizeOptionalString(entry?.name ?? id) || id;
      const contextWindow =
        typeof entry?.contextWindow === "number" && entry.contextWindow > 0
          ? entry.contextWindow
          : undefined;
      const contextTokens =
        typeof entry?.contextTokens === "number" && entry.contextTokens > 0
          ? entry.contextTokens
          : undefined;
      const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
      const api = typeof entry?.api === "string" ? entry.api : undefined;
      const input = Array.isArray(entry?.input) ? entry.input : undefined;
      const modelParams =
        entry?.params && typeof entry.params === "object" ? entry.params : undefined;
      const compat = entry?.compat && typeof entry.compat === "object" ? entry.compat : undefined;
      const model = {
        id,
        name,
        provider,
        ...(api ? { api } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        contextWindow,
        ...(contextTokens !== undefined ? { contextTokens } : {}),
        reasoning,
        input,
        ...(modelParams ? { params: modelParams } : {}),
        compat,
      } satisfies ModelCatalogEntry;
      models.push(model);
      mergeCatalogRouteVariants(routeVariants, [model]);
    }
    const manifestModels = loadManifestModelCatalog({
      config: cfg,
      env,
      metadataSnapshot: manifestMetadataSnapshot,
    });
    mergeCatalogRouteVariants(routeVariants, manifestModels);
    mergeCatalogEntries(models, manifestModels);
    logStage("manifest-models-merged", `entries=${models.length}`);
    const configuredModels = buildConfiguredModelCatalog({
      cfg,
      manifestPlugins: hasConfiguredProviderModelRows(cfg) ? getManifestPlugins() : undefined,
    });
    let augmentEntries: ModelCatalogEntry[] | undefined;
    if (configuredModels.length > 0) {
      const entriesForAugment = [...models];
      mergeCatalogEntries(entriesForAugment, configuredModels, {
        catalogCompatRoutes: routeVariants.entries,
        preserveBaseCompat: true,
        preserveBaseName: true,
      });
      augmentEntries = entriesForAugment;
    }
    logStage("configured-models-prepared", `entries=${models.length}`);

    if (!params.readOnly && params.includeProviderPluginAugmentation !== false) {
      const { createProviderApiKeyResolverFromPreparedCredentials } =
        await loadProviderApiKeyResolver();
      const resolveProviderApiKeyForProvider = createProviderApiKeyResolverFromPreparedCredentials(
        env,
        params.authCredentials,
        cfg,
      );
      const resolveProviderApiKey = (providerId?: string) =>
        providerId?.trim()
          ? resolveProviderApiKeyForProvider(providerId)
          : { apiKey: undefined, discoveryApiKey: undefined };
      const supplemental = await augmentModelCatalogWithProviderPlugins({
        config: cfg,
        workspaceDir,
        env,
        metadataSnapshot: manifestMetadataSnapshot,
        context: {
          config: cfg,
          agentDir: params.agentDir,
          workspaceDir,
          env,
          resolveProviderApiKey,
          entries: augmentEntries ?? [...models],
        },
      });
      if (supplemental.length > 0) {
        const normalizedSupplemental: ModelCatalogEntry[] = [];
        for (const entry of supplemental) {
          normalizedSupplemental.push({
            ...entry,
            id: normalizeConfiguredProviderCatalogModelId(entry.provider, entry.id, {
              manifestPlugins: getManifestPlugins(),
            }),
          });
        }
        mergeCatalogRouteVariants(routeVariants, normalizedSupplemental);
        mergeCatalogEntries(models, normalizedSupplemental);
      }
    }
    logStage("plugin-models-merged", `entries=${models.length}`);

    if (configuredModels.length > 0) {
      mergeCatalogRouteVariants(routeVariants, configuredModels, { preserveBaseCompat: true });
      mergeCatalogEntries(models, configuredModels, {
        catalogCompatRoutes: routeVariants.entries,
        preserveBaseCompat: true,
        preserveBaseName: true,
      });
    }
    logStage("configured-models-finalized", `entries=${models.length}`);

    const snapshot = createModelCatalogSnapshot(models, routeVariants);
    logStage("complete", `entries=${snapshot.entries.length}`);
    return snapshot;
  } catch (error) {
    if (!hasLoggedModelCatalogError) {
      hasLoggedModelCatalogError = true;
      log.warn(`Failed to load model catalog: ${String(error)}`);
    }
    throw error;
  }
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return modelCatalogEntrySupportsInput(entry, "image");
}

/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
export function modelSupportsDocument(entry: ModelCatalogEntry | undefined): boolean {
  return modelCatalogEntrySupportsInput(entry, "document");
}
