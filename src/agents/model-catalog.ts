/**
 * Loads bundled, manifest, and discovered model catalog entries.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveClaudeFable5ModelIdentity } from "@openclaw/llm-core";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { planManifestModelCatalogRows } from "../model-catalog/manifest-planner.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "./auth-profiles.js";
import { modelSupportsInput as modelCatalogEntrySupportsInput } from "./model-catalog-lookup.js";
import {
  buildAgentModelCatalogCacheKey,
  readCachedAgentModelCatalogSnapshot,
  writeCachedAgentModelCatalog,
} from "./model-catalog-state-cache.js";
import type {
  ModelCatalogEntry,
  ModelCatalogSnapshot,
  ModelInputType,
} from "./model-catalog.types.js";
import { resolveModelWorkspaceDir } from "./model-discovery-context.js";
import {
  modelKey,
  normalizeConfiguredProviderCatalogModelId,
  type ProviderModelIdNormalizationOptions,
} from "./model-ref-shared.js";
import {
  buildConfiguredModelCatalog,
  hasConfiguredProviderModelRows,
} from "./model-selection-shared.js";
import {
  buildModelsJsonSourceFingerprint,
  prepareOpenClawModelsJsonSource,
} from "./models-config.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  listPluginModelCatalogFiles,
  type PluginModelCatalogMetadataSnapshot,
} from "./plugin-model-catalog.js";

const log = createSubsystemLogger("model-catalog");
const AGENT_CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW = 128_000;

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

type AgentDiscoveryModule = typeof import("./agent-model-discovery.js");

export type LoadModelCatalogParams = {
  agentDir?: string;
  config?: OpenClawConfig;
  useCache?: boolean;
  cacheOnly?: boolean;
  readOnly?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
};

let modelCatalogPromise: Promise<ModelCatalogSnapshot> | null = null;
let loadedModelCatalogSnapshot: ModelCatalogSnapshot | undefined;
let loadedModelCatalogGeneration = -1;
let modelCatalogGeneration = 0;
let hasLoggedModelCatalogError = false;
let hasLoggedReadOnlyStaticCatalogError = false;
type ManifestModelCatalogCacheEntry = {
  snapshot: PluginMetadataSnapshot;
  rows: ModelCatalogEntry[];
};
let manifestModelCatalogCache = new WeakMap<OpenClawConfig, ManifestModelCatalogCacheEntry>();
function buildLoadModelCatalogStateCacheKey(params: {
  agentDir: string;
  config: OpenClawConfig;
  metadataSnapshot?: PluginMetadataSnapshot;
  sourceFingerprint: string;
  workspaceDir?: string;
}): string {
  return buildAgentModelCatalogCacheKey({
    agentDir: params.agentDir,
    cacheScope: {
      source: "load-model-catalog",
      sourceFingerprint: params.sourceFingerprint,
    },
    config: params.config,
    metadataSnapshot: params.metadataSnapshot,
    workspaceDir: params.workspaceDir,
  });
}
const defaultImportAgentDiscovery = () => import("./agent-model-discovery.js");
let importAgentDiscovery = defaultImportAgentDiscovery;
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

export function resetModelCatalogCache() {
  modelCatalogPromise = null;
  modelCatalogGeneration += 1;
  manifestModelCatalogCache = new WeakMap();
  hasLoggedModelCatalogError = false;
  hasLoggedReadOnlyStaticCatalogError = false;
}

export function resetModelCatalogCacheForTest() {
  resetModelCatalogCache();
  loadedModelCatalogSnapshot = undefined;
  loadedModelCatalogGeneration = -1;
  importAgentDiscovery = defaultImportAgentDiscovery;
}

// Test-only escape hatch: allow mocking discovery failures without touching module state.
export function setModelCatalogImportForTest(loader?: () => Promise<AgentDiscoveryModule>) {
  importAgentDiscovery = loader ?? defaultImportAgentDiscovery;
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
  options?: { preserveBaseName?: boolean },
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
    compat: mergeCatalogCompat(routeBase.compat, overlay.compat),
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
  options?: { preserveBaseName?: boolean },
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
      models[existingIndex] = overlayCatalogMetadata(existing, entry, options);
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
    collector.entries[existingIndex] = overlayCatalogMetadata(existingEntry, entry);
  }
}

function createModelCatalogSnapshot(
  entries: ModelCatalogEntry[],
  routeVariants: ModelCatalogRouteVariantCollector,
  authoritative = true,
): ModelCatalogSnapshot {
  return {
    entries: sortModelCatalogEntries(entries),
    routeVariants: sortModelCatalogEntries(routeVariants.entries),
    authoritative,
  };
}

const EMPTY_DEGRADED_MODEL_CATALOG_SNAPSHOT: ModelCatalogSnapshot = {
  entries: [],
  routeVariants: [],
  authoritative: false,
};

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

function normalizePersistedModelCatalogEntry(
  providerRaw: string,
  entry: Record<string, unknown>,
  defaults?: {
    api?: ModelCatalogEntry["api"];
    baseUrl?: string;
    contextWindow?: number;
    contextTokens?: number;
  },
  options: {
    manifestPlugins?: ProviderModelIdNormalizationOptions["manifestPlugins"];
  } = {},
): ModelCatalogEntry | undefined {
  const rawId = normalizeOptionalString(entry.id) ?? "";
  if (!rawId) {
    return undefined;
  }
  const provider = normalizeProviderId(providerRaw);
  if (!provider) {
    return undefined;
  }
  const id = normalizeConfiguredProviderCatalogModelId(provider, rawId, options);
  const name = normalizeOptionalString(entry.name ?? id) || id;
  const contextWindow =
    typeof entry?.contextWindow === "number" && entry.contextWindow > 0
      ? entry.contextWindow
      : defaults?.contextWindow !== undefined
        ? defaults.contextWindow
        : AGENT_CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW;
  const contextTokens =
    typeof entry?.contextTokens === "number" && entry.contextTokens > 0
      ? entry.contextTokens
      : defaults?.contextTokens !== undefined
        ? defaults.contextTokens
        : undefined;
  const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : false;
  const api =
    typeof entry?.api === "string" ? (entry.api as ModelCatalogEntry["api"]) : defaults?.api;
  const baseUrl = normalizeOptionalString(entry?.baseUrl) ?? defaults?.baseUrl;
  const parsedInput = Array.isArray(entry?.input)
    ? entry.input.filter((value): value is ModelInputType =>
        ["text", "image", "audio", "video", "document"].includes(String(value)),
      )
    : undefined;
  const input: ModelInputType[] = parsedInput?.length ? parsedInput : ["text"];
  const compat =
    entry?.compat && typeof entry.compat === "object"
      ? (entry.compat as ModelCatalogEntry["compat"])
      : undefined;
  const modelParams =
    entry?.params && typeof entry.params === "object"
      ? (entry.params as ModelCatalogEntry["params"])
      : undefined;
  return {
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
  };
}

function readProviderCatalogRows(parsed: unknown): Record<string, Record<string, unknown>> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const providers = (parsed as { providers?: unknown }).providers;
  return providers && typeof providers === "object" && !Array.isArray(providers)
    ? (providers as Record<string, Record<string, unknown>>)
    : {};
}

async function loadReadOnlyPersistedProviderRows(
  agentDir: string,
  getPluginMetadataSnapshot: () => PluginModelCatalogMetadataSnapshot,
): Promise<Record<string, Record<string, unknown>>> {
  const raw = await readFile(join(agentDir, "models.json"), "utf8");
  const providers = { ...readProviderCatalogRows(JSON.parse(raw) as unknown) };
  for (const catalogFile of listPluginModelCatalogFiles(agentDir)) {
    const catalogRaw = await readFile(catalogFile.path, "utf8").catch(() => undefined);
    if (!catalogRaw) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(catalogRaw) as unknown;
    } catch {
      continue;
    }
    Object.assign(
      providers,
      filterGeneratedPluginModelCatalogProviders({
        catalogPluginId: catalogFile.pluginId,
        parsedCatalog: parsed,
        pluginMetadataSnapshot: getPluginMetadataSnapshot(),
        providers: readProviderCatalogRows(parsed),
      }),
    );
  }
  return providers;
}

async function loadReadOnlyPersistedModelCatalog(params?: {
  config?: OpenClawConfig;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ModelCatalogSnapshot> {
  const cfg = params?.config ?? getRuntimeConfig();
  const agentDir = resolveDefaultAgentDir(cfg);
  const workspaceDir = resolveModelWorkspaceDir(cfg, undefined);
  const models: ModelCatalogEntry[] = [];
  const routeVariants = createModelCatalogRouteVariantCollector();
  const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
  const shouldSuppressBuiltInModel = buildShouldSuppressBuiltInModel({ config: cfg });
  let metadataSnapshot: PluginMetadataSnapshot | undefined = params?.metadataSnapshot;
  const getMetadataSnapshot = () => {
    metadataSnapshot ??= loadManifestMetadataSnapshot({
      config: cfg,
      env: process.env,
      workspaceDir,
    });
    return metadataSnapshot;
  };
  let manifestPlugins: ProviderModelIdNormalizationOptions["manifestPlugins"];
  const getManifestPlugins = () => {
    manifestPlugins ??= getMetadataSnapshot().plugins;
    return manifestPlugins;
  };
  const providers = await loadReadOnlyPersistedProviderRows(agentDir, getMetadataSnapshot);
  for (const [providerRaw, providerConfig] of Object.entries(providers)) {
    if (!Array.isArray(providerConfig?.models)) {
      continue;
    }
    const providerContextWindow =
      typeof providerConfig?.contextWindow === "number" && providerConfig.contextWindow > 0
        ? providerConfig.contextWindow
        : undefined;
    const providerContextTokens =
      typeof providerConfig?.contextTokens === "number" && providerConfig.contextTokens > 0
        ? providerConfig.contextTokens
        : undefined;
    const providerApi =
      typeof providerConfig?.api === "string"
        ? (providerConfig.api as ModelCatalogEntry["api"])
        : undefined;
    const providerBaseUrl = normalizeOptionalString(providerConfig?.baseUrl);
    for (const entry of providerConfig.models as Record<string, unknown>[]) {
      const normalized = normalizePersistedModelCatalogEntry(
        providerRaw,
        entry,
        {
          api: providerApi,
          baseUrl: providerBaseUrl,
          contextWindow: providerContextWindow,
          contextTokens: providerContextTokens,
        },
        { manifestPlugins: getManifestPlugins() },
      );
      if (normalized && !shouldSuppressBuiltInModel(normalized)) {
        models.push(normalized);
        mergeCatalogRouteVariants(routeVariants, [normalized]);
      }
    }
  }
  if (models.length === 0) {
    throw new Error("persisted model catalog has no usable model rows");
  }
  try {
    const manifestModels = loadManifestModelCatalog({
      config: cfg,
      env: process.env,
      fallbackToMetadataScan: false,
      metadataSnapshot: getMetadataSnapshot(),
    });
    mergeCatalogRouteVariants(routeVariants, manifestModels);
    mergeCatalogEntries(models, manifestModels);
  } catch {
    // Persisted rows are still valid when manifest metadata is temporarily unavailable.
  }
  const configuredModels = buildConfiguredModelCatalog({
    cfg,
    manifestPlugins: hasConfiguredProviderModelRows(cfg) ? getManifestPlugins() : undefined,
  });
  if (configuredModels.length > 0) {
    mergeCatalogRouteVariants(routeVariants, configuredModels);
    mergeCatalogEntries(models, configuredModels, { preserveBaseName: true });
  }
  return createModelCatalogSnapshot(models, routeVariants);
}

function hasConfiguredProviderRowsNeedingManifestLookup(cfg: OpenClawConfig): boolean {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  return Object.entries(providers).some(
    ([providerRaw, provider]) =>
      Array.isArray(provider?.models) && normalizeProviderId(providerRaw) !== "openai",
  );
}

function loadReadOnlyStaticModelCatalog(params?: {
  config?: OpenClawConfig;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ModelCatalogSnapshot {
  const cfg = params?.config ?? getRuntimeConfig();
  const models: ModelCatalogEntry[] = [];
  const routeVariants = createModelCatalogRouteVariantCollector();
  try {
    const manifestModels = loadManifestModelCatalog({
      config: cfg,
      env: process.env,
      fallbackToMetadataScan: false,
      metadataSnapshot: params?.metadataSnapshot,
    });
    mergeCatalogRouteVariants(routeVariants, manifestModels);
    mergeCatalogEntries(models, manifestModels);
  } catch (error) {
    if (!hasLoggedReadOnlyStaticCatalogError) {
      hasLoggedReadOnlyStaticCatalogError = true;
      log.warn(`Failed to load read-only manifest model catalog: ${String(error)}`);
    }
  }

  const configuredManifestPlugins = hasConfiguredProviderRowsNeedingManifestLookup(cfg)
    ? (params?.metadataSnapshot?.plugins ??
      resolvePluginMetadataSnapshot({
        config: cfg,
        env: process.env,
        allowWorkspaceScopedCurrent: true,
      }).plugins)
    : [];
  const configuredModels = buildConfiguredModelCatalog({
    cfg,
    manifestPlugins: configuredManifestPlugins,
  });
  if (configuredModels.length > 0) {
    mergeCatalogRouteVariants(routeVariants, configuredModels);
    mergeCatalogEntries(models, configuredModels, { preserveBaseName: true });
  }
  // Static-only catalog: discovery/persisted rows were unavailable, so this is degraded.
  return createModelCatalogSnapshot(models, routeVariants, false);
}

/** Loads logical entries together with browse-only physical route provenance. */
export async function loadModelCatalogSnapshot(
  params?: LoadModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  if (params?.cacheOnly === true) {
    return loadedModelCatalogGeneration === modelCatalogGeneration
      ? (loadedModelCatalogSnapshot ?? EMPTY_DEGRADED_MODEL_CATALOG_SNAPSHOT)
      : EMPTY_DEGRADED_MODEL_CATALOG_SNAPSHOT;
  }
  const readOnly = params?.readOnly === true;
  if (readOnly) {
    try {
      return await loadReadOnlyPersistedModelCatalog(params);
    } catch {
      // Keep gateway models.list on side-effect-free sources. The RPC timeout
      // cannot fire while provider discovery blocks the event loop.
      return loadReadOnlyStaticModelCatalog(params);
    }
  }
  if (!readOnly && params?.useCache === false) {
    modelCatalogPromise = null;
    modelCatalogGeneration += 1;
  }
  const useSharedCache = !readOnly && !params?.metadataSnapshot;
  if (useSharedCache && modelCatalogPromise) {
    return modelCatalogPromise;
  }

  const loadCatalog = async () => {
    const models: ModelCatalogEntry[] = [];
    const routeVariants = createModelCatalogRouteVariantCollector();
    const cfg = params?.config ?? getRuntimeConfig();
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
      const workspaceDir = params?.workspaceDir ?? resolveModelWorkspaceDir(cfg, undefined);
      let manifestMetadataSnapshot: PluginMetadataSnapshot | undefined;
      let manifestPlugins: ProviderModelIdNormalizationOptions["manifestPlugins"];
      const getManifestMetadataSnapshot = () => {
        manifestMetadataSnapshot ??=
          params?.metadataSnapshot ??
          loadManifestMetadataSnapshot({
            config: cfg,
            env: process.env,
            workspaceDir,
          });
        return manifestMetadataSnapshot;
      };
      const getManifestPlugins = () => {
        manifestPlugins ??= getManifestMetadataSnapshot().plugins;
        return manifestPlugins;
      };
      const agentDir = params?.agentDir ?? resolveDefaultAgentDir(cfg);
      const sourceFingerprint = await buildModelsJsonSourceFingerprint(cfg, agentDir, {
        pluginMetadataSnapshot: params?.metadataSnapshot,
        workspaceDir,
      });
      let catalogKey = buildLoadModelCatalogStateCacheKey({
        agentDir,
        config: cfg,
        metadataSnapshot: params?.metadataSnapshot,
        sourceFingerprint: sourceFingerprint.fingerprint,
        workspaceDir,
      });
      if (!readOnly && params?.useCache !== false) {
        const cachedSnapshot = readCachedAgentModelCatalogSnapshot({ agentDir, catalogKey }) as
          | { entries: ModelCatalogEntry[]; routeVariants: ModelCatalogEntry[] }
          | undefined;
        if (cachedSnapshot?.entries.length) {
          logStage("state-cache-hit", `entries=${cachedSnapshot.entries.length}`);
          return cachedSnapshot;
        }
      }
      if (!readOnly) {
        const preparedSource = await prepareOpenClawModelsJsonSource(cfg, agentDir, {
          pluginMetadataSnapshot: params?.metadataSnapshot,
          workspaceDir,
        });
        const preparedCatalogKey = buildLoadModelCatalogStateCacheKey({
          agentDir,
          config: cfg,
          metadataSnapshot: params?.metadataSnapshot,
          sourceFingerprint: preparedSource.fingerprint,
          workspaceDir: preparedSource.workspaceDir ?? workspaceDir,
        });
        logStage("models-json-ready");
        if (preparedCatalogKey !== catalogKey) {
          catalogKey = preparedCatalogKey;
          if (params?.useCache !== false) {
            const cachedSnapshot = readCachedAgentModelCatalogSnapshot({
              agentDir,
              catalogKey,
            }) as { entries: ModelCatalogEntry[]; routeVariants: ModelCatalogEntry[] } | undefined;
            if (cachedSnapshot?.entries.length) {
              logStage("state-cache-hit", `entries=${cachedSnapshot.entries.length}`);
              return cachedSnapshot;
            }
          }
        }
      }
      // Keep discovery inside try/catch so transient filesystem/config failures do not poison
      // the shared catalog cache until restart.
      const agentDiscovery = await importAgentDiscovery();
      logStage("agent-discovery-imported");
      const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
      logStage("catalog-deps-ready");
      const authStorage = agentDiscovery.discoverAuthStorage(
        agentDir,
        readOnly ? { readOnly: true } : undefined,
      );
      logStage("auth-storage-ready");
      const registry = agentDiscovery.discoverModels(authStorage, agentDir, {
        config: cfg,
        pluginMetadataSnapshot: getManifestMetadataSnapshot(),
        workspaceDir,
      });
      logStage("registry-ready");
      const entries = registry.getAll() as DiscoveredModel[];
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
        env: process.env,
        metadataSnapshot: getManifestMetadataSnapshot(),
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
        mergeCatalogEntries(entriesForAugment, configuredModels, { preserveBaseName: true });
        augmentEntries = entriesForAugment;
      }
      logStage("configured-models-prepared", `entries=${models.length}`);

      if (!readOnly) {
        const { createProviderApiKeyResolver } = await loadProviderApiKeyResolver();
        let authStore: ReturnType<typeof ensureAuthProfileStoreWithoutExternalProfiles> | undefined;
        const resolveProviderApiKeyForProvider = createProviderApiKeyResolver(
          process.env,
          () =>
            (authStore ??= ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
              allowKeychainPrompt: false,
            })),
          cfg,
        );
        const resolveProviderApiKey = (providerId?: string) =>
          providerId?.trim()
            ? resolveProviderApiKeyForProvider(providerId)
            : { apiKey: undefined, discoveryApiKey: undefined };
        const supplemental = await augmentModelCatalogWithProviderPlugins({
          config: cfg,
          workspaceDir,
          env: process.env,
          context: {
            config: cfg,
            agentDir,
            workspaceDir,
            env: process.env,
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
        mergeCatalogRouteVariants(routeVariants, configuredModels);
        mergeCatalogEntries(models, configuredModels, { preserveBaseName: true });
      }
      logStage("configured-models-finalized", `entries=${models.length}`);

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        if (useSharedCache) {
          modelCatalogPromise = null;
        }
      }

      const snapshot = createModelCatalogSnapshot(models, routeVariants);
      if (!readOnly) {
        writeCachedAgentModelCatalog({
          agentDir,
          catalogKey,
          entries: snapshot.entries,
          routeVariants: snapshot.routeVariants,
        });
      }
      logStage("complete", `entries=${snapshot.entries.length}`);
      return snapshot;
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        log.warn(`Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      if (useSharedCache) {
        modelCatalogPromise = null;
      }
      if (models.length > 0) {
        return createModelCatalogSnapshot(models, routeVariants, false);
      }
      return EMPTY_DEGRADED_MODEL_CATALOG_SNAPSHOT;
    }
  };

  if (readOnly || params?.metadataSnapshot) {
    return loadCatalog();
  }

  const loadGeneration = modelCatalogGeneration;
  const publishedPromise = loadCatalog().then((snapshot) => {
    if (
      snapshot.entries.length > 0 &&
      modelCatalogGeneration === loadGeneration &&
      modelCatalogPromise === publishedPromise
    ) {
      loadedModelCatalogSnapshot = snapshot;
      loadedModelCatalogGeneration = loadGeneration;
    }
    return snapshot;
  });
  modelCatalogPromise = publishedPromise;
  return publishedPromise;
}

/** Loads the deduplicated logical catalog for runtime and legacy consumers. */
export async function loadModelCatalog(
  params?: LoadModelCatalogParams,
): Promise<ModelCatalogEntry[]> {
  return (await loadModelCatalogSnapshot(params)).entries;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
