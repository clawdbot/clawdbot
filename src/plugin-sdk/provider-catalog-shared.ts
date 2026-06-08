// Provider catalog helpers normalize, hash, and expose model catalogs for provider plugins.
import { createHash } from "node:crypto";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type {
  ModelCatalogCost,
  ModelCatalogMediaInputConfig,
  ModelCatalogModel,
  ModelCatalogTieredCost,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

export type { ProviderCatalogContext, ProviderCatalogResult } from "../plugins/types.js";

export {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "../plugins/provider-catalog.js";

/**
 * Normalized model row read from user config for provider catalog augmentation.
 */
export type ConfiguredProviderCatalogEntry = {
  /** Normalized model id as exposed through provider catalog discovery. */
  id: string;
  /** Display name from config, falling back to the normalized id. */
  name: string;
  /** Published provider id attached to this catalog entry. */
  provider: string;
  /** Optional context window copied from the configured model row when positive. */
  contextWindow?: number;
  /** Whether the configured model advertises reasoning support. */
  reasoning?: boolean;
  /** Runtime input modalities retained from the configured model row. */
  input?: Array<"text" | "image" | "audio" | "video" | "document">;
};

type LiveCatalogCacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

const LIVE_CATALOG_CACHE_MAX_ENTRIES = 100;
const liveCatalogCache = new Map<string, LiveCatalogCacheEntry<unknown>>();

function buildLiveCatalogCacheKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Caches one live catalog load promise by stable key parts for a short TTL.
 */
export async function getCachedLiveCatalogValue<T>(params: {
  /** Stable JSON-serializable values that identify one provider/config catalog load. */
  keyParts: readonly unknown[];
  /** Loader for the live catalog value when no fresh cache entry exists. */
  load: () => Promise<T>;
  /** Optional predicate for values that are healthy enough to retain. */
  shouldCache?: (value: T) => boolean;
  /** Cache lifetime in milliseconds; defaults to a short provider-discovery TTL. */
  ttlMs?: number;
  /** Test hook for deterministic cache expiry. */
  now?: () => number;
}): Promise<T> {
  const rawNow = params.now?.() ?? Date.now();
  const ttlMs = params.ttlMs ?? 30_000;
  const key = buildLiveCatalogCacheKey(params.keyParts);
  const existing = liveCatalogCache.get(key) as LiveCatalogCacheEntry<T> | undefined;
  if (existing) {
    if (isFutureDateTimestampMs(existing.expiresAt, { nowMs: rawNow })) {
      return await existing.value;
    }
    liveCatalogCache.delete(key);
  }
  const value = params.load();
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
  if (expiresAt !== undefined) {
    // Auth-scoped live provider catalogs can vary by token; keep this
    // process-local cache bounded so discovery cannot grow without limit.
    if (liveCatalogCache.size >= LIVE_CATALOG_CACHE_MAX_ENTRIES) {
      const oldestKey = liveCatalogCache.keys().next();
      if (!oldestKey.done) {
        liveCatalogCache.delete(oldestKey.value);
      }
    }
    liveCatalogCache.set(key, {
      expiresAt,
      value,
    });
  }
  try {
    const resolved = await value;
    if (params.shouldCache && !params.shouldCache(resolved)) {
      liveCatalogCache.delete(key);
    }
    return resolved;
  } catch (err) {
    // Failed live discovery should not poison later retries for the same provider/config.
    liveCatalogCache.delete(key);
    throw err;
  }
}

/**
 * Clears the process-local live catalog cache for tests and isolated plugin probes.
 */
export function clearLiveCatalogCacheForTests(): void {
  liveCatalogCache.clear();
}

function countRawManifestCatalogModels(catalog: unknown): number | undefined {
  if (!catalog || typeof catalog !== "object") {
    return undefined;
  }
  const models = (catalog as { models?: unknown }).models;
  return Array.isArray(models) ? models.length : undefined;
}

function cloneManifestCatalogTieredCost(
  tier: ModelCatalogTieredCost,
): NonNullable<ModelDefinitionConfig["cost"]["tieredPricing"]>[number] {
  return {
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead,
    cacheWrite: tier.cacheWrite,
    range: tier.range.length === 1 ? [tier.range[0]] : [tier.range[0], tier.range[1]],
  };
}

function cloneManifestCatalogCost(cost: ModelCatalogCost): ModelDefinitionConfig["cost"] {
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    ...(cost.tieredPricing
      ? { tieredPricing: cost.tieredPricing.map(cloneManifestCatalogTieredCost) }
      : {}),
  };
}

function buildManifestCatalogModelInput(model: ModelCatalogModel): ModelDefinitionConfig["input"] {
  if (model.input?.includes("document")) {
    throw new Error(
      `Manifest modelCatalog row ${model.id} uses unsupported runtime input document`,
    );
  }
  return model.input?.filter((item): item is "text" | "image" => item !== "document") ?? ["text"];
}

function cloneManifestCatalogMediaInput(
  mediaInput?: ModelCatalogMediaInputConfig,
): ModelDefinitionConfig["mediaInput"] | undefined {
  if (!mediaInput?.image) {
    return undefined;
  }
  return {
    image: { ...mediaInput.image },
  };
}

function buildManifestCatalogModel(
  providerId: string,
  model: ModelCatalogModel,
): ModelDefinitionConfig {
  if (model.contextWindow === undefined) {
    throw new Error(`Manifest modelCatalog row ${model.id} is missing contextWindow`);
  }
  if (model.maxTokens === undefined) {
    throw new Error(`Manifest modelCatalog row ${model.id} is missing maxTokens`);
  }
  const id = normalizeConfiguredProviderCatalogModelId(providerId, model.id, {
    allowManifestNormalization: false,
  });
  return {
    id,
    name: model.name ?? id,
    ...(model.api ? { api: model.api } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    reasoning: model.reasoning ?? false,
    input: buildManifestCatalogModelInput(model),
    cost: cloneManifestCatalogCost(model.cost ?? {}),
    contextWindow: model.contextWindow,
    ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    maxTokens: model.maxTokens,
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
    ...(model.mediaInput ? { mediaInput: cloneManifestCatalogMediaInput(model.mediaInput) } : {}),
  };
}

/**
 * Converts a plugin manifest modelCatalog provider into runtime provider config.
 */
export function buildManifestModelProviderConfig(params: {
  /** Provider id that owns the manifest catalog rows. */
  providerId: string;
  /** Raw manifest modelCatalog provider block to normalize into runtime config. */
  catalog: unknown;
}): ModelProviderConfig {
  const catalog = normalizeModelCatalog(
    { providers: { [params.providerId]: params.catalog } },
    { ownedProviders: new Set([params.providerId]) },
  )?.providers?.[params.providerId];
  if (!catalog) {
    throw new Error(`Missing modelCatalog.providers.${params.providerId}`);
  }
  if (!catalog.baseUrl) {
    throw new Error(`Missing modelCatalog.providers.${params.providerId}.baseUrl`);
  }
  const rawModelCount = countRawManifestCatalogModels(params.catalog);
  if (rawModelCount !== undefined && rawModelCount !== catalog.models.length) {
    throw new Error(`Invalid modelCatalog.providers.${params.providerId}.models`);
  }
  return {
    baseUrl: catalog.baseUrl,
    ...(catalog.api ? { api: catalog.api } : {}),
    ...(catalog.headers ? { headers: { ...catalog.headers } } : {}),
    models: catalog.models.map((model) => buildManifestCatalogModel(params.providerId, model)),
  };
}

function normalizeConfiguredCatalogModelInput(
  input: unknown,
): ConfiguredProviderCatalogEntry["input"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is "text" | "image" | "audio" | "video" | "document" =>
      item === "text" ||
      item === "image" ||
      item === "audio" ||
      item === "video" ||
      item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function resolveConfiguredProviderModels(
  config: OpenClawConfig | undefined,
  providerId: string,
): ModelDefinitionConfig[] {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const providerKey = findNormalizedProviderKey(providers, providerId);
  if (!providerKey) {
    return [];
  }
  const providerConfig = providers[providerKey];
  if (!providerConfig || typeof providerConfig !== "object") {
    return [];
  }
  return Array.isArray(providerConfig.models) ? providerConfig.models : [];
}

/**
 * Reads user-configured provider models as catalog entries for plugin discovery output.
 */
export function readConfiguredProviderCatalogEntries(params: {
  /** Runtime config containing optional user-defined provider model rows. */
  config?: OpenClawConfig;
  /** Provider id used to locate configured model rows. */
  providerId: string;
  /** Provider id to publish on emitted catalog entries when it differs from lookup id. */
  publishedProviderId?: string;
}): ConfiguredProviderCatalogEntry[] {
  const provider = params.publishedProviderId ?? params.providerId;
  const models = resolveConfiguredProviderModels(params.config, params.providerId);
  const entries: ConfiguredProviderCatalogEntry[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) {
      continue;
    }
    const normalizedId = normalizeConfiguredProviderCatalogModelId(provider, id);
    const name =
      (typeof model.name === "string" ? model.name : normalizedId).trim() || normalizedId;
    const contextWindow =
      typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : undefined;
    const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : undefined;
    const input = normalizeConfiguredCatalogModelInput(model.input);
    entries.push({
      provider,
      id: normalizedId,
      name,
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(input ? { input } : {}),
    });
  }
  return entries;
}

function withStreamingUsageCompat(provider: ModelProviderConfig): ModelProviderConfig {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return provider;
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (model.compat?.supportsUsageInStreaming !== undefined) {
      return model;
    }
    changed = true;
    return {
      ...model,
      compat: {
        ...model.compat,
        supportsUsageInStreaming: true,
      },
    };
  });

  return changed ? { ...provider, models } : provider;
}

/**
 * Returns whether a provider transport can report native usage while streaming.
 */
export function supportsNativeStreamingUsageCompat(params: {
  /** Provider id used for transport capability lookup. */
  providerId: string;
  /** Provider endpoint URL used to detect native streaming usage behavior. */
  baseUrl: string | undefined;
}): boolean {
  return resolveProviderRequestCapabilities({
    provider: params.providerId,
    api: "openai-completions",
    baseUrl: params.baseUrl,
    capability: "llm",
    transport: "stream",
  }).supportsNativeStreamingUsageCompat;
}

/**
 * Marks models as streaming-usage compatible when provider transport capabilities allow it.
 */
export function applyProviderNativeStreamingUsageCompat(params: {
  /** Provider id used for transport capability lookup. */
  providerId: string;
  /** Runtime provider config whose model compat flags may be filled in. */
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return supportsNativeStreamingUsageCompat({
    providerId: params.providerId,
    baseUrl: params.providerConfig.baseUrl,
  })
    ? withStreamingUsageCompat(params.providerConfig)
    : params.providerConfig;
}
