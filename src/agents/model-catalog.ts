/**
 * Loads bundled, manifest, and discovered model catalog entries.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
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
import { ensureOpenClawModelsJson } from "./models-config.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  listPluginModelCatalogFiles,
  type PluginModelCatalogMetadataSnapshot,
} from "./plugin-model-catalog.js";

const log = createSubsystemLogger("model-catalog");
const AGENT_CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW = 128_000;

export type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
export {
  findModelCatalogEntry,
  findModelInCatalog,
  modelSupportsInput,
} from "./model-catalog-lookup.js";

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  compat?: ModelCatalogEntry["compat"];
};

type AgentDiscoveryModule = typeof import("./agent-model-discovery.js");

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
let hasLoggedReadOnlyStaticCatalogError = false;
type ManifestModelCatalogCacheEntry = {
  snapshot: PluginMetadataSnapshot;
  rows: ModelCatalogEntry[];
};
let manifestModelCatalogCache = new WeakMap<OpenClawConfig, ManifestModelCatalogCacheEntry>();
const defaultImportAgentDiscovery = () => import("./agent-model-discovery.js");
let importAgentDiscovery = defaultImportAgentDiscovery;
const modelSuppressionLoader = createLazyImportLoader(
  () => import("./model-suppression.runtime.js"),
);
const providerApiKeyResolverLoader = createLazyImportLoader(
  () => import("./models-config.providers.secrets.js"),
);

function shouldLogModelCatalogTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

function loadModelSuppression() {
  return modelSuppressionLoader.load();
}

function loadProviderApiKeyResolver() {
  return providerApiKeyResolverLoader.load();
}

export function resetModelCatalogCache() {
  modelCatalogPromise = null;
  manifestModelCatalogCache = new WeakMap();
  hasLoggedModelCatalogError = false;
  hasLoggedReadOnlyStaticCatalogError = false;
}

export function resetModelCatalogCacheForTest() {
  resetModelCatalogCache();
  importAgentDiscovery = defaultImportAgentDiscovery;
}

// Test-only escape hatch: allow mocking discovery failures without touching module state.
export function setModelCatalogImportForTest(loader?: () => Promise<AgentDiscoveryModule>) {
  importAgentDiscovery = loader ?? defaultImportAgentDiscovery;
}

/** @deprecated Use `setModelCatalogImportForTest`. */
export { setModelCatalogImportForTest as __setModelCatalogImportForTest };

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

function overlayCatalogMetadata(
  base: ModelCatalogEntry,
  overlay: ModelCatalogEntry,
): ModelCatalogEntry {
  return {
    ...base,
    ...(overlay.contextWindow !== undefined ? { contextWindow: overlay.contextWindow } : {}),
    ...(overlay.contextTokens !== undefined ? { contextTokens: overlay.contextTokens } : {}),
    ...(overlay.reasoning !== undefined ? { reasoning: overlay.reasoning } : {}),
    ...(overlay.input !== undefined ? { input: overlay.input } : {}),
    compat: mergeCatalogCompat(base.compat, overlay.compat),
  };
}

function mergeCatalogEntries(models: ModelCatalogEntry[], entries: ModelCatalogEntry[]): void {
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
    models[existingIndex] = overlayCatalogMetadata(models[existingIndex], entry);
  }
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
  return entries.toSorted((a, b) => {
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
  return {
    id,
    name,
    provider,
    contextWindow,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    reasoning,
    input,
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
}): Promise<ModelCatalogEntry[]> {
  const cfg = params?.config ?? getRuntimeConfig();
  const agentDir = resolveDefaultAgentDir(cfg);
  const workspaceDir = resolveModelWorkspaceDir(cfg, undefined);
  const models: ModelCatalogEntry[] = [];
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
    for (const entry of providerConfig.models as Record<string, unknown>[]) {
      const normalized = normalizePersistedModelCatalogEntry(
        providerRaw,
        entry,
        {
          contextWindow: providerContextWindow,
          contextTokens: providerContextTokens,
        },
        { manifestPlugins: getManifestPlugins() },
      );
      if (normalized && !shouldSuppressBuiltInModel(normalized)) {
        models.push(normalized);
      }
    }
  }
  if (models.length === 0) {
    throw new Error("persisted model catalog has no usable model rows");
  }
  try {
    mergeCatalogEntries(
      models,
      loadManifestModelCatalog({
        config: cfg,
        env: process.env,
        fallbackToMetadataScan: false,
        metadataSnapshot: getMetadataSnapshot(),
      }),
    );
  } catch {
    // Persisted rows are still valid when manifest metadata is temporarily unavailable.
  }
  const configuredModels = buildConfiguredModelCatalog({
    cfg,
    manifestPlugins: hasConfiguredProviderModelRows(cfg) ? getManifestPlugins() : undefined,
  });
  if (configuredModels.length > 0) {
    mergeCatalogEntries(models, configuredModels);
  }
  return sortModelCatalogEntries(models);
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
}): ModelCatalogEntry[] {
  const cfg = params?.config ?? getRuntimeConfig();
  const models: ModelCatalogEntry[] = [];
  try {
    mergeCatalogEntries(
      models,
      loadManifestModelCatalog({
        config: cfg,
        env: process.env,
        fallbackToMetadataScan: false,
        metadataSnapshot: params?.metadataSnapshot,
      }),
    );
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
    mergeCatalogEntries(models, configuredModels);
  }
  return sortModelCatalogEntries(models);
}

export async function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
  readOnly?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ModelCatalogEntry[]> {
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
  }
  const useSharedCache = !readOnly && !params?.metadataSnapshot;
  if (useSharedCache && modelCatalogPromise) {
    return modelCatalogPromise;
  }

  const loadCatalog = async () => {
    const models: ModelCatalogEntry[] = [];
    const timingEnabled = shouldLogModelCatalogTiming();
    const startMs = timingEnabled ? Date.now() : 0;
    const logStage = (stage: string, extra?: string) => {
      if (!timingEnabled) {
        return;
      }
      const suffix = extra ? ` ${extra}` : "";
      log.info(`model-catalog stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
    };
    const sortModels = sortModelCatalogEntries;
    try {
      const cfg = params?.config ?? getRuntimeConfig();
      const workspaceDir = resolveModelWorkspaceDir(cfg, undefined);
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
      if (!readOnly) {
        await ensureOpenClawModelsJson(cfg);
        logStage("models-json-ready");
      }
      // Keep discovery inside try/catch so transient filesystem/config failures do not poison
      // the shared catalog cache until restart.
      const agentDiscovery = await importAgentDiscovery();
      logStage("agent-discovery-imported");
      const agentDir = resolveDefaultAgentDir(cfg);
      const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
      logStage("catalog-deps-ready");
      const authStorage = agentDiscovery.discoverAuthStorage(
        agentDir,
        readOnly ? { readOnly: true } : undefined,
      );
      logStage("auth-storage-ready");
      const registry = agentDiscovery.discoverModels(authStorage, agentDir, {
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
        if (shouldSuppressBuiltInModel({ provider, id })) {
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
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        const compat = entry?.compat && typeof entry.compat === "object" ? entry.compat : undefined;
        models.push({
          id,
          name,
          provider,
          contextWindow,
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          reasoning,
          input,
          compat,
        });
      }
      mergeCatalogEntries(
        models,
        loadManifestModelCatalog({
          config: cfg,
          env: process.env,
          metadataSnapshot: getManifestMetadataSnapshot(),
        }),
      );
      logStage("manifest-models-merged", `entries=${models.length}`);
      const configuredModels = buildConfiguredModelCatalog({
        cfg,
        manifestPlugins: hasConfiguredProviderModelRows(cfg) ? getManifestPlugins() : undefined,
      });
      let augmentEntries: ModelCatalogEntry[] | undefined;
      if (configuredModels.length > 0) {
        const entriesForAugment = [...models];
        mergeCatalogEntries(entriesForAugment, configuredModels);
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
          env: process.env,
          context: {
            config: cfg,
            agentDir,
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
          mergeCatalogEntries(models, normalizedSupplemental);
        }
      }
      logStage("plugin-models-merged", `entries=${models.length}`);

      if (configuredModels.length > 0) {
        mergeCatalogEntries(models, configuredModels);
      }
      logStage("configured-models-finalized", `entries=${models.length}`);

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        if (useSharedCache) {
          modelCatalogPromise = null;
        }
      }

      const sorted = sortModels(models);
      logStage("complete", `entries=${sorted.length}`);
      return sorted;
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
        return sortModels(models);
      }
      return [];
    }
  };

  if (readOnly || params?.metadataSnapshot) {
    return loadCatalog();
  }

  modelCatalogPromise = loadCatalog();
  return modelCatalogPromise;
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
