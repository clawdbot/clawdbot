// Shared provider catalog helpers for provider plugins.
//
// Keep provider-owned exports out of this subpath so plugin loaders can import it
// without recursing through provider-specific facades.

import { createHash } from "node:crypto";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import { findNormalizedProviderKey } from "../agents/provider-id.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeModelCatalog } from "../model-catalog/normalize.js";
import type {
  ModelCatalogCost,
  ModelCatalogModel,
  ModelCatalogTieredCost,
} from "../model-catalog/types.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

export type { ProviderCatalogContext, ProviderCatalogResult } from "../plugins/types.js";

export {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "../plugins/provider-catalog.js";

export type ConfiguredProviderCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "audio" | "video" | "document">;
};

type LiveCatalogCacheEntry<T> = {
  expiresAt: number;
  value: Promise<T>;
};

const liveCatalogCache = new Map<string, LiveCatalogCacheEntry<unknown>>();

function buildLiveCatalogCacheKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function getCachedLiveCatalogValue<T>(params: {
  keyParts: readonly unknown[];
  load: () => Promise<T>;
  ttlMs?: number;
  now?: () => number;
}): Promise<T> {
  const now = params.now?.() ?? Date.now();
  const ttlMs = params.ttlMs ?? 30_000;
  const key = buildLiveCatalogCacheKey(params.keyParts);
  const existing = liveCatalogCache.get(key) as LiveCatalogCacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    return await existing.value;
  }
  const value = params.load();
  liveCatalogCache.set(key, {
    expiresAt: now + ttlMs,
    value,
  });
  try {
    return await value;
  } catch (err) {
    liveCatalogCache.delete(key);
    throw err;
  }
}

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
  const id = normalizeConfiguredProviderCatalogModelId(providerId, model.id);
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
  };
}

export function buildManifestModelProviderConfig(params: {
  providerId: string;
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

export function readConfiguredProviderCatalogEntries(params: {
  config?: OpenClawConfig;
  providerId: string;
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

export function supportsNativeStreamingUsageCompat(params: {
  providerId: string;
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

export function applyProviderNativeStreamingUsageCompat(params: {
  providerId: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return supportsNativeStreamingUsageCompat({
    providerId: params.providerId,
    baseUrl: params.providerConfig.baseUrl,
  })
    ? withStreamingUsageCompat(params.providerConfig)
    : params.providerConfig;
}
