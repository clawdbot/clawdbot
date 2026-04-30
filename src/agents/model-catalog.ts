import { join } from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { modelSupportsInput as modelCatalogEntrySupportsInput } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { normalizeProviderId } from "./provider-id.js";

const log = createSubsystemLogger("model-catalog");

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
const defaultImportPiSdk = () => import("./pi-model-discovery-runtime.js");
let importPiSdk = defaultImportPiSdk;
let modelSuppressionPromise: Promise<typeof import("./model-suppression.runtime.js")> | undefined;

function shouldLogModelCatalogTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

function loadModelSuppression() {
  modelSuppressionPromise ??= import("./model-suppression.runtime.js");
  return modelSuppressionPromise;
}

export function resetModelCatalogCache() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
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

export async function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
  readOnly?: boolean;
}): Promise<ModelCatalogEntry[]> {
  const readOnly = params?.readOnly === true;
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
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) {
          return p;
        }
        return a.name.localeCompare(b.name);
      });
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
      const agentDir = resolveOpenClawAgentDir();
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
        const id = normalizeOptionalString(entry?.id) ?? "";
        if (!id) {
          continue;
        }
        const provider = normalizeOptionalString(entry?.provider) ?? "";
        if (!provider) {
          continue;
        }
        if (shouldSuppressBuiltInModel({ provider, id })) {
          continue;
        }
        const name = normalizeOptionalString(entry?.name ?? id) || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        const compat = entry?.compat && typeof entry.compat === "object" ? entry.compat : undefined;
        models.push({ id, name, provider, contextWindow, reasoning, input, compat });
      }
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
        appendCatalogEntriesIfAbsent(models, supplemental);
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
