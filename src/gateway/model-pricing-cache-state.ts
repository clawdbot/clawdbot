import { normalizeModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type CachedPricingTier = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** [startTokens, endTokens) — half-open interval on the input token axis. */
  range: [number, number];
};

export type CachedModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Optional tiered pricing tiers sourced from LiteLLM or local config. */
  tieredPricing?: CachedPricingTier[];
};

let cachedPricing = new Map<string, CachedModelPricing>();
let cachedAt = 0;

const WRAPPER_PROVIDERS = new Set([
  "cloudflare-ai-gateway",
  "kilocode",
  "openrouter",
  "vercel-ai-gateway",
]);

function modelPricingCacheKey(provider: string, model: string): string {
  const providerId = normalizeProviderId(provider);
  const modelId = model.trim();
  if (!providerId || !modelId) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(modelId).startsWith(
    `${normalizeLowercaseStringOrEmpty(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

function shouldNormalizeCachedPricingLookup(provider: string): boolean {
  const normalized = normalizeProviderId(provider);
  return (
    normalized === "anthropic" ||
    normalized === "openrouter" ||
    normalized === "xai" ||
    WRAPPER_PROVIDERS.has(normalized)
  );
}

export function replaceGatewayModelPricingCache(
  nextPricing: Map<string, CachedModelPricing>,
  nextCachedAt = Date.now(),
): void {
  cachedPricing = nextPricing;
  cachedAt = nextCachedAt;
}

export function clearGatewayModelPricingCacheState(): void {
  cachedPricing = new Map();
  cachedAt = 0;
}

export function getCachedGatewayModelPricing(params: {
  provider?: string;
  model?: string;
}): CachedModelPricing | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const key = modelPricingCacheKey(provider, model);
  const direct = key ? cachedPricing.get(key) : undefined;
  if (direct) {
    return direct;
  }
  if (!shouldNormalizeCachedPricingLookup(provider)) {
    return undefined;
  }
  const normalized = normalizeModelRef(provider, model);
  const normalizedKey = modelPricingCacheKey(normalized.provider, normalized.model);
  return normalizedKey ? cachedPricing.get(normalizedKey) : undefined;
}

export function getGatewayModelPricingCacheMeta(): {
  cachedAt: number;
  ttlMs: number;
  size: number;
} {
  return {
    cachedAt,
    ttlMs: 0,
    size: cachedPricing.size,
  };
}

export function __resetGatewayModelPricingCacheForTest(): void {
  clearGatewayModelPricingCacheState();
}

export function __setGatewayModelPricingForTest(
  entries: Array<{ provider: string; model: string; pricing: CachedModelPricing }>,
): void {
  replaceGatewayModelPricingCache(
    new Map(
      entries.flatMap((entry) => {
        const normalized = normalizeModelRef(entry.provider, entry.model, {
          allowPluginNormalization: false,
        });
        const key = modelPricingCacheKey(normalized.provider, normalized.model);
        return key ? ([[key, entry.pricing]] as const) : [];
      }),
    ),
  );
}
