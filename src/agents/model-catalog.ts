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
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { modelSupportsInput as modelCatalogEntrySupportsInput } from "./model-catalog-lookup.js";
import { assignProviderModelOrder, compareModelCatalogEntries } from "./model-catalog-order.js";
import type {
  ModelCatalogEntry,
  ModelCatalogSnapshot,
  ModelInputType,
} from "./model-catalog.types.js";
import { resolveCatalogOwnedModelCompat } from "./model-compat-catalog.js";
import { modelKey, createConfiguredProviderCatalogModelIdNormalizer } from "./model-ref-shared.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
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
  thinkingLevelMap?: ModelCatalogEntry["thinkingLevelMap"];
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
const loadModelSuppression = createLazyPromise(() => import("./model-suppression.js"));
const loadProviderApiKeyResolver = createLazyPromise(
  () => import("./models-config.providers.secrets.js"),
);

export function resetModelCatalogBuilderCacheForTest() {
  manifestModelCatalogCache = new WeakMap();
  hasLoggedModelCatalogError = false;
}

/** Prepares provider aliases once for one captured catalog metadata generation. */
export function createPreparedModelCatalogProviderNormalizer(
  metadataSnapshot: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): (provider: string) => string {
  let aliases: Map<string, string> | undefined;
  return (provider) => {
    const normalizedProvider = normalizeProviderId(provider);
    if (!aliases) {
      aliases = new Map();
      for (const plugin of metadataSnapshot.manifestRegistry.plugins) {
        for (const [alias, target] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
          const key = normalizeProviderId(alias);
          const canonicalProvider = normalizeProviderId(target.provider);
          // Duplicate aliases retain the first nonempty target in manifest order.
          if (canonicalProvider && !aliases.has(key)) {
            aliases.set(key, canonicalProvider);
          }
        }
      }
    }
    return aliases.get(normalizedProvider) ?? normalizedProvider;
  };
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
    contextWindows: _contextWindows,
    contextWindowDefault: _contextWindowDefault,
    contextTokens: _contextTokens,
    reasoning: _reasoning,
    thinkingLevelMap: _thinkingLevelMap,
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
    catalogRoute?: ModelCatalogEntry;
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
  const thinkingLevelMap = overlay.thinkingLevelMap ?? options?.catalogRoute?.thinkingLevelMap;
  // Options + default are one normalized unit (default ∈ options): an overlay
  // that replaces the options list must also own the default, or a base default
  // absent from the new list would leak through the field-by-field merge.
  const {
    contextWindows: _baseContextWindows,
    contextWindowDefault: _baseContextWindowDefault,
    ...selectionNeutralBase
  } = routeBase;
  const contextWindowSelection =
    overlay.contextWindows !== undefined
      ? {
          contextWindows: overlay.contextWindows,
          ...(overlay.contextWindowDefault !== undefined
            ? { contextWindowDefault: overlay.contextWindowDefault }
            : {}),
        }
      : {
          ...(routeBase.contextWindows !== undefined
            ? { contextWindows: routeBase.contextWindows }
            : {}),
          ...((overlay.contextWindowDefault ?? routeBase.contextWindowDefault)
            ? {
                contextWindowDefault:
                  overlay.contextWindowDefault ?? routeBase.contextWindowDefault,
              }
            : {}),
        };
  return {
    ...selectionNeutralBase,
    ...contextWindowSelection,
    ...(routeChanged && !options?.preserveBaseName ? { name: overlay.name } : {}),
    ...(overlay.api !== undefined ? { api: overlay.api } : {}),
    ...(overlay.baseUrl !== undefined ? { baseUrl: overlay.baseUrl } : {}),
    ...(overlay.contextWindow !== undefined ? { contextWindow: overlay.contextWindow } : {}),
    ...(overlay.contextTokens !== undefined ? { contextTokens: overlay.contextTokens } : {}),
    ...(overlay.reasoning !== undefined ? { reasoning: overlay.reasoning } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(overlay.input !== undefined ? { input: overlay.input } : {}),
    ...(params ? { params } : {}),
    ...(overlay.mediaInput !== undefined ? { mediaInput: overlay.mediaInput } : {}),
    ...(overlay.providerOrder !== undefined ? { providerOrder: overlay.providerOrder } : {}),
    ...(overlay.status !== undefined ? { status: overlay.status } : {}),
    ...(overlay.statusReason !== undefined ? { statusReason: overlay.statusReason } : {}),
    ...(overlay.replaces !== undefined ? { replaces: overlay.replaces } : {}),
    ...(overlay.replacedBy !== undefined ? { replacedBy: overlay.replacedBy } : {}),
    compat: options?.preserveBaseCompat
      ? resolveCatalogOwnedModelCompat({
          catalogRoute: options.catalogRoute ?? base,
          catalogCompat: (options.catalogRoute ?? base).compat,
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
    catalogRoutes?: ModelCatalogRouteVariantCollector;
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
      // Logical rows can represent a sibling route; capabilities must come
      // from the exact catalog variant selected by config, not that sibling.
      const routes = options?.catalogRoutes;
      const routeIndex = options?.preserveBaseCompat
        ? routes?.indexByKey.get(catalogRouteVariantKey(entry))
        : undefined;
      const catalogRoute = routeIndex === undefined ? undefined : routes?.entries[routeIndex];
      models[existingIndex] = overlayCatalogMetadata(existing, entry, {
        ...options,
        catalogRoute,
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

function resolveEligibleManifestCatalogPlugins(
  snapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): PluginMetadataSnapshot["plugins"] {
  return snapshot.plugins.filter(
    (plugin) =>
      plugin.modelCatalog &&
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
      }),
  );
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
  const plugins = resolveEligibleManifestCatalogPlugins(resolvedSnapshot, params.config);
  const plan = planEffectiveModelCatalogRows({
    registry: { plugins },
    config: params.config,
  });
  const providerOrderByKey = new Map<string, number>();
  for (const plugin of plugins) {
    for (const [provider, providerCatalog] of Object.entries(
      plugin.modelCatalog?.providers ?? {},
    )) {
      providerCatalog.models.forEach((model, providerOrder) => {
        const key = catalogEntryDedupeKey(provider, model.id);
        if (!providerOrderByKey.has(key)) {
          providerOrderByKey.set(key, providerOrder);
        }
      });
    }
  }
  const rows = plan.rows.map((row) => {
    const entry = modelCatalogRowToEntry(row);
    const providerOrder = providerOrderByKey.get(catalogEntryDedupeKey(row.provider, row.id));
    if (providerOrder !== undefined) {
      entry.providerOrder = providerOrder;
    }
    return entry;
  });
  manifestModelCatalogCache.set(params.config, { snapshot: resolvedSnapshot, rows });
  return rows;
}

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.map(normalizeCatalogEntryContract).toSorted(compareModelCatalogEntries);
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
    const normalizeModelId = createConfiguredProviderCatalogModelIdNormalizer({
      manifestPlugins: manifestMetadataSnapshot,
    });
    const normalizeProvider =
      createPreparedModelCatalogProviderNormalizer(manifestMetadataSnapshot);
    const { buildShouldSuppressBuiltInModelCore } = await loadModelSuppression();
    logStage("catalog-deps-ready");
    const entries = params.modelRegistry.getAll() as DiscoveredModel[];
    const declaredManifestModels = loadManifestModelCatalog({
      config: cfg,
      env,
      metadataSnapshot: manifestMetadataSnapshot,
    });
    logStage("registry-read", `entries=${entries.length}`);

    const shouldSuppressBuiltInModel = buildShouldSuppressBuiltInModelCore({ config: cfg });
    logStage("suppress-resolver-ready");

    for (const entry of entries) {
      const rawId = normalizeOptionalString(entry?.id) ?? "";
      if (!rawId) {
        continue;
      }
      const rawProvider = normalizeOptionalString(entry?.provider) ?? "";
      if (!rawProvider) {
        continue;
      }
      const provider = normalizeProvider(rawProvider);
      const id = normalizeModelId(provider, rawId);
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
        ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
        input,
        ...(modelParams ? { params: modelParams } : {}),
        compat,
      } satisfies ModelCatalogEntry;
      models.push(model);
    }
    // Gateway startup may publish registry rows without runtime augmentation.
    // Rank them here so both static startup and later live enrichment preserve
    // provider-owned order instead of falling back to model-id sorting.
    const orderedRegistryModels = assignProviderModelOrder(models, declaredManifestModels, {
      appendUnknown: false,
    });
    models.splice(0, models.length, ...orderedRegistryModels);
    mergeCatalogRouteVariants(routeVariants, orderedRegistryModels);
    const supplementalManifestPlan = planEffectiveModelCatalogRows({
      registry: {
        plugins: resolveEligibleManifestCatalogPlugins(manifestMetadataSnapshot, cfg),
      },
      config: cfg,
      selection: "supplemental",
    });
    const supplementalManifestKeys = new Set(
      supplementalManifestPlan.rows.map((entry) => catalogEntryDedupeKey(entry.provider, entry.id)),
    );
    const runtimeDiscoveryProviders = new Set(
      supplementalManifestPlan.entries.flatMap((entry) =>
        entry.discovery === "runtime" ? [normalizeProviderId(entry.provider)] : [],
      ),
    );
    // Runtime declarations describe possible models, not account entitlement.
    // Only live registry or refreshed rows may publish those provider models.
    const manifestModels = declaredManifestModels.filter((entry) =>
      supplementalManifestKeys.has(catalogEntryDedupeKey(entry.provider, entry.id)),
    );
    mergeCatalogRouteVariants(routeVariants, manifestModels);
    mergeCatalogEntries(models, manifestModels);
    logStage("manifest-models-merged", `entries=${models.length}`);
    const configuredModels = buildConfiguredModelCatalog({
      cfg,
      manifestPlugins: manifestMetadataSnapshot,
    });
    logStage("configured-models-prepared", `entries=${models.length}`);

    if (!params.readOnly && params.includeProviderPluginAugmentation !== false) {
      const augmentEntries = [...models];
      if (configuredModels.length > 0) {
        mergeCatalogEntries(augmentEntries, configuredModels, {
          catalogRoutes: routeVariants,
          preserveBaseCompat: true,
          preserveBaseName: true,
        });
      }
      const { createProviderApiKeyResolverFromPreparedCredentials } =
        await loadProviderApiKeyResolver();
      const resolveProviderApiKeyForProvider = createProviderApiKeyResolverFromPreparedCredentials(
        env,
        params.authCredentials,
        cfg,
        workspaceDir,
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
          entries: augmentEntries,
        },
      });
      if (supplemental.length > 0) {
        // Explicitly configured rows are user-authorized even when live
        // discovery omits them; normalize both sets to preserve their routes.
        const accountVisibleModelKeys = new Set(
          [...models, ...configuredModels].map((entry) =>
            catalogEntryDedupeKey(entry.provider, normalizeModelId(entry.provider, entry.id)),
          ),
        );
        const normalizedSupplemental: ModelCatalogEntry[] = [];
        for (const entry of supplemental) {
          const provider = normalizeProvider(entry.provider);
          const id = normalizeModelId(provider, entry.id);
          // Account-discovered providers own the visible model set. Synthetic
          // metadata can enrich an available or explicitly configured model,
          // but must never advertise a model the account did not discover.
          if (
            runtimeDiscoveryProviders.has(normalizeProviderId(provider)) &&
            !accountVisibleModelKeys.has(catalogEntryDedupeKey(provider, id))
          ) {
            continue;
          }
          normalizedSupplemental.push({
            ...entry,
            provider,
            id,
          });
        }
        // Manifest ranks are provider-owned policy. Live discovery enriches
        // those rows and appends unknown models without replacing the ranking.
        const orderedSupplemental = assignProviderModelOrder(normalizedSupplemental, [
          ...declaredManifestModels,
          ...models,
        ]);
        mergeCatalogRouteVariants(routeVariants, orderedSupplemental);
        mergeCatalogEntries(models, orderedSupplemental);
      }
    }
    logStage("plugin-models-merged", `entries=${models.length}`);

    if (configuredModels.length > 0) {
      mergeCatalogRouteVariants(routeVariants, configuredModels, { preserveBaseCompat: true });
      // Augmentation may mutate borrowed rows. Reindex after the final merge so
      // route lookup keeps the first current match, including duplicate keys.
      routeVariants.indexByKey.clear();
      routeVariants.entries.forEach((entry, index) => {
        const key = catalogRouteVariantKey(entry);
        if (!routeVariants.indexByKey.has(key)) {
          routeVariants.indexByKey.set(key, index);
        }
      });
      mergeCatalogEntries(models, configuredModels, {
        catalogRoutes: routeVariants,
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
