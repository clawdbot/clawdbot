// Gateway model-pricing cache state.
// Stores normalized pricing rows and source-health failures for runtime reads.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeModelRef } from "../agents/model-selection.js";
import type { GatewayModelPricingHealth } from "./model-pricing-cache.types.js";

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

type GatewayModelPricingHealthSource = GatewayModelPricingHealth["sources"][number]["source"];

let cachedPricing = new Map<string, CachedModelPricing>();
let cachedAt = 0;
const sourceFailures = new Map<
  GatewayModelPricingHealthSource,
  { lastFailureAt: number; detail: string }
>();

function modelPricingCacheKey(provider: string, model: string): string {
  // Keys accept both provider/model and provider-prefixed model ids so external
  // catalogs can be queried without double-prefixing.
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

export function replaceGatewayModelPricingCache(
  nextPricing: Map<string, CachedModelPricing>,
  nextCachedAt = Date.now(),
): void {
  cachedPricing = nextPricing;
  cachedAt = nextCachedAt;
}

export function recordGatewayModelPricingSourceFailure(
  source: GatewayModelPricingHealthSource,
  detail: string,
  failedAt = Date.now(),
): void {
  sourceFailures.set(source, {
    lastFailureAt: failedAt,
    detail,
  });
}

export function clearGatewayModelPricingSourceFailure(
  source: GatewayModelPricingHealthSource,
): void {
  sourceFailures.delete(source);
}

export function clearGatewayModelPricingFailures(): void {
  sourceFailures.clear();
}

export function getGatewayModelPricingHealth(params?: {
  enabled?: boolean;
}): GatewayModelPricingHealth {
  if (params?.enabled === false) {
    return {
      state: "disabled",
      sources: [],
    };
  }
  const sources: GatewayModelPricingHealth["sources"] = Array.from(sourceFailures.entries())
    .map(([source, failure]) => ({
      source,
      state: "degraded" as const,
      lastFailureAt: failure.lastFailureAt,
      detail: failure.detail,
    }))
    .toSorted((left, right) => left.source.localeCompare(right.source));
  const latest = sources.reduce<(typeof sources)[number] | undefined>((current, source) => {
    if (!current || (source.lastFailureAt ?? 0) > (current.lastFailureAt ?? 0)) {
      return source;
    }
    return current;
  }, undefined);
  return {
    state: sources.length > 0 ? "degraded" : "ok",
    sources,
    ...(latest?.lastFailureAt ? { lastFailureAt: latest.lastFailureAt } : {}),
    ...(latest?.detail ? { detail: latest.detail } : {}),
  };
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
  const normalized = normalizeModelRef(provider, model);
  const normalizedKey = modelPricingCacheKey(normalized.provider, normalized.model);
  if (normalizedKey === key) {
    return undefined;
  }
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

function stablePricingValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stablePricingValue(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stablePricingValue(record[key])}`)
    .join(",")}}`;
}

export function getGatewayModelPricingCacheFingerprint(): string {
  const entries = Array.from(cachedPricing.entries()).toSorted(([a], [b]) => a.localeCompare(b));
  return stablePricingValue(entries);
}
