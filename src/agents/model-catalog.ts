import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { planManifestModelCatalogRows } from "../model-catalog/manifest-planner.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import { modelSupportsInput as modelCatalogEntrySupportsInput } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
import { normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { normalizeProviderId } from "./provider-id.js";

const log = createSubsystemLogger("model-catalog");
const PI_CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW = 128_000;

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

type PiSdkModule = typeof import("./pi-model-discovery-runtime.js");
type PiRegistryInstance =
  | Array<DiscoveredModel>
  | {
      getAll: () => Array<DiscoveredModel>;
    };
type PiRegistryClassLike = {
  create?: (authStorage: unknown, modelsFile: string) => PiRegistryInstance;
  new (authStorage: unknown, modelsFile: string): PiRegistryInstance;
};

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
let hasLoggedReadOnlyStaticCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery-runtime.js");
let importPiSdk = defaultImportPiSdk;
const modelSuppressionLoader = createLazyImportLoader(
  () => import("./model-suppression.runtime.js"),
);

function shouldLogModelCatalogTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

function loadModelSuppression() {
  return modelSuppressionLoader.load();
}

export function resetModelCatalogCache() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
  hasLoggedReadOnlyStaticCatalogError = false;
}

export function resetModelCatalogCacheForTest() {
  resetModelCatalogCache();
  importPiSdk = defaultImportPiSdk;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

function instantiatePiModelRegistry(
  piSdk: PiSdkModule,
  authStorage: unknown,
  modelsFile: string,
): PiRegistryInstance {
  const Registry = piSdk.ModelRegistry as unknown as PiRegistryClassLike;
  if (typeof Registry.create === "function") {
    return Registry.create(authStorage, modelsFile);
  }
  return new Registry(authStorage, modelsFile);
}

function catalogEntryDedupeKey(provider: string, id: string): string {
  return `${normalizeProviderId(provider)}::${normalizeLowercaseStringOrEmpty(id)}`;
}

function appendCatalogEntriesIfAbsent(
  models: ModelCatalogEntry[],
  entries: ModelCatalogEntry[],
): void {
  const seen = new Set(models.map((entry) => catalogEntryDedupeKey(entry.provider, entry.id)));
  for (const entry of entries) {
    const key = catalogEntryDedupeKey(entry.provider, entry.id);
    if (seen.has(key)) {
      continue;
    }
    models.push(entry);
    seen.add(key);
  }
}

export function loadManifestModelCatalog(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  fallbackToMetadataScan?: boolean;
}): ModelCatalogEntry[] {
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.workspaceDir === undefined ? { allowWorkspaceScopedSnapshot: true } : {}),
  });
  const resolvedSnapshot =
    snapshot ??
    (params.fallbackToMetadataScan === false
      ? undefined
      : loadPluginMetadataSnapshot({
          config: params.config,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          env: params.env ?? process.env,
        }));
  if (!resolvedSnapshot) {
    return [];
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
  return plan.rows.map((row) => {
    const entry: ModelCatalogEntry = {
      id: row.id,
      name: row.name,
      provider: row.provider,
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
): ModelCatalogEntry | undefined {
  const rawId = normalizeOptionalString(entry.id) ?? "";
  if (!rawId) {
    return undefined;
  }
  const provider = normalizeProviderId(providerRaw);
  if (!provider) {
    return undefined;
  }
  const id = normalizeConfiguredProviderCatalogModelId(provider, rawId);
  const name = normalizeOptionalString(entry.name ?? id) || id;
  const contextWindow =
    typeof entry?.contextWindow === "number" && entry.contextWindow > 0
      ? entry.contextWindow
      : defaults?.contextWindow !== undefined
        ? defaults.contextWindow
        : PI_CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW;
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

async function loadReadOnlyPersistedModelCatalog(params?: {
  config?: OpenClawConfig;
}): Promise<ModelCatalogEntry[]> {
  const cfg = params?.config ?? getRuntimeConfig();
  const agentDir = resolveDefaultAgentDir(cfg);
  const raw = await readFile(join(agentDir, "models.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const models: ModelCatalogEntry[] = [];
  const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
  const shouldSuppressBuiltInModel = buildShouldSuppressBuiltInModel({ config: cfg });
  const providers =
    parsed?.providers && typeof parsed.providers === "object"
      ? (parsed.providers as Record<string, Record<string, unknown>>)
      : {};
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
      const normalized = normalizePersistedModelCatalogEntry(providerRaw, entry, {
        contextWindow: providerContextWindow,
        contextTokens: providerContextTokens,
      });
      if (normalized && !shouldSuppressBuiltInModel(normalized)) {
        models.push(normalized);
      }
    }
  }
  if (models.length === 0) {
    throw new Error("persisted model catalog has no usable model rows");
  }
  const configuredModels = buildConfiguredModelCatalog({ cfg });
  if (configuredModels.length > 0) {
    appendCatalogEntriesIfAbsent(models, configuredModels);
  }
  return sortModelCatalogEntries(models);
}

function loadReadOnlyStaticModelCatalog(params?: { config?: OpenClawConfig }): ModelCatalogEntry[] {
  const cfg = params?.config ?? getRuntimeConfig();
  const models: ModelCatalogEntry[] = [];
  try {
    appendCatalogEntriesIfAbsent(
      models,
      loadManifestModelCatalog({
        config: cfg,
        env: process.env,
        fallbackToMetadataScan: false,
      }),
    );
  } catch (error) {
    if (!hasLoggedReadOnlyStaticCatalogError) {
      hasLoggedReadOnlyStaticCatalogError = true;
      log.warn(`Failed to load read-only manifest model catalog: ${String(error)}`);
    }
  }

  const configuredModels = buildConfiguredModelCatalog({ cfg });
  if (configuredModels.length > 0) {
    appendCatalogEntriesIfAbsent(models, configuredModels);
  }
  return sortModelCatalogEntries(models);
}

export async function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
  readOnly?: boolean;
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
  if (!readOnly && modelCatalogPromise) {
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
      if (!readOnly) {
        await ensureOpenClawModelsJson(cfg);
        logStage("models-json-ready");
      }
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      logStage("pi-sdk-imported");
      const agentDir = resolveDefaultAgentDir(cfg);
      const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
      logStage("catalog-deps-ready");
      const authStorage = piSdk.discoverAuthStorage(
        agentDir,
        readOnly ? { readOnly: true } : undefined,
      );
      logStage("auth-storage-ready");
      const registry = instantiatePiModelRegistry(
        piSdk,
        authStorage,
        join(agentDir, "models.json"),
      );
      logStage("registry-ready");
      const entries = Array.isArray(registry) ? registry : registry.getAll();
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
        const id = normalizeConfiguredProviderCatalogModelId(provider, rawId);
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
      if (!readOnly) {
        const supplemental = await augmentModelCatalogWithProviderPlugins({
          config: cfg,
          env: process.env,
          context: {
            config: cfg,
            agentDir,
            env: process.env,
            entries: [...models],
          },
        });
        if (supplemental.length > 0) {
          const normalizedSupplemental: ModelCatalogEntry[] = [];
          for (const entry of supplemental) {
            normalizedSupplemental.push({
              ...entry,
              id: normalizeConfiguredProviderCatalogModelId(entry.provider, entry.id),
            });
          }
          appendCatalogEntriesIfAbsent(models, normalizedSupplemental);
        }
      }
      logStage("plugin-models-merged", `entries=${models.length}`);

      const configuredModels = buildConfiguredModelCatalog({ cfg });
      if (configuredModels.length > 0) {
        appendCatalogEntriesIfAbsent(models, configuredModels);
      }
      logStage("configured-models-merged", `entries=${models.length}`);

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        if (!readOnly) {
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
      if (!readOnly) {
        modelCatalogPromise = null;
      }
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  };

  if (readOnly) {
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
