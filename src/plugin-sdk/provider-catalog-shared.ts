// Provider catalog helpers normalize, hash, and expose model catalogs for provider plugins.
import { createHash } from "node:crypto";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

export type {
  ProviderCatalogContext,
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "../plugins/types.js";

export {
  buildManifestModelProviderConfig,
  buildManifestProviderCatalogFamily,
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
  readManifestProviderDefaultModelRef,
  type ManifestProviderCatalogEntry,
  type ManifestProviderCatalogSurface,
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
  const expiresAt = resolveExpiresAtMsFromDurationMs(params.ttlMs ?? 30_000, { nowMs: rawNow });
  // Uncached callers must neither reuse nor disturb an existing entry.
  if (expiresAt === undefined) {
    return await params.load();
  }
  const key = buildLiveCatalogCacheKey(params.keyParts);
  const existing = liveCatalogCache.get(key) as LiveCatalogCacheEntry<T> | undefined;
  if (existing) {
    if (isFutureDateTimestampMs(existing.expiresAt, { nowMs: rawNow })) {
      return await existing.value;
    }
    liveCatalogCache.delete(key);
  }
  const entry = { expiresAt, value: params.load() };
  // Auth-scoped live provider catalogs can vary by token; keep this
  // process-local cache bounded so discovery cannot grow without limit.
  pruneMapToMaxSize(liveCatalogCache, LIVE_CATALOG_CACHE_MAX_ENTRIES - 1);
  liveCatalogCache.set(key, entry);
  let retain = false;
  try {
    const resolved = await entry.value;
    retain = params.shouldCache?.(resolved) ?? true;
    return resolved;
  } finally {
    // Expired work may finish after a replacement load. Only its own entry
    // can be removed when loading or the cache predicate fails.
    if (!retain && liveCatalogCache.get(key) === entry) {
      liveCatalogCache.delete(key);
    }
  }
}

/**
 * Clears the process-local live catalog cache for tests and isolated plugin probes.
 */
export function clearLiveCatalogCacheForTests(): void {
  liveCatalogCache.clear();
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
