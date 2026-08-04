// Vercel Ai Gateway plugin module implements models behavior.
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { buildLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";

export const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
export const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6";
export const VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 200_000;
export const VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS = 128_000;
export const VERCEL_AI_GATEWAY_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const VERCEL_AI_GATEWAY_DISCOVERY_CACHE_TTL_MS = 60_000;
const VERCEL_AI_GATEWAY_DISCOVERY_TIMEOUT_MS = 5000;

type VercelPricingShape = {
  input?: number | string;
  output?: number | string;
  input_cache_read?: number | string;
  input_cache_write?: number | string;
  input_tiers?: unknown;
  output_tiers?: unknown;
  input_cache_read_tiers?: unknown;
  input_cache_write_tiers?: unknown;
};

type ParsedVercelPricingTier = {
  cost: number;
  min: number;
  max?: number;
};

type VercelGatewayModelShape = {
  id?: string;
  type?: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
  tags?: string[];
  pricing?: VercelPricingShape;
};

type StaticVercelGatewayModel = Omit<ModelDefinitionConfig, "cost"> & {
  cost?: Partial<ModelDefinitionConfig["cost"]>;
};

const STATIC_VERCEL_AI_GATEWAY_MODEL_CATALOG: readonly StaticVercelGatewayModel[] = [
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
  {
    id: "openai/gpt-5.4",
    name: "GPT 5.4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 128_000,
    cost: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
    },
  },
  {
    id: "openai/gpt-5.4-pro",
    name: "GPT 5.4 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 128_000,
    cost: {
      input: 30,
      output: 180,
      cacheRead: 0,
    },
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: {
      input: 0.95,
      output: 4,
      cacheRead: 0.16,
    },
  },
] as const;

function parsePerMillionCost(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseStrictFiniteNumber(value)
        : undefined;
  if (numeric === undefined || !Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  const perMillion = numeric * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : undefined;
}

function toPerMillionCost(value: number | string | undefined): number {
  return parsePerMillionCost(value) ?? 0;
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function parsePricingTierList(value: unknown): ParsedVercelPricingTier[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const tiers: ParsedVercelPricingTier[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const entry = item as Record<string, unknown>;
    const cost = parsePerMillionCost(entry.cost);
    const min = entry.min === undefined && index === 0 ? 0 : readNonNegativeSafeInteger(entry.min);
    const max = entry.max === undefined ? undefined : readNonNegativeSafeInteger(entry.max);
    if (cost === undefined || min === undefined || (entry.max !== undefined && max === undefined)) {
      return undefined;
    }
    if (max !== undefined && max <= min) {
      return undefined;
    }
    tiers.push({ cost, min, ...(max === undefined ? {} : { max }) });
  }
  if (tiers[0]?.min !== 0 || tiers.at(-1)?.max !== undefined) {
    return undefined;
  }
  for (let index = 1; index < tiers.length; index += 1) {
    if (tiers[index - 1]?.max !== tiers[index]?.min) {
      return undefined;
    }
  }
  return tiers;
}

function pricingTierRangesMatch(
  reference: ParsedVercelPricingTier[],
  candidate: ParsedVercelPricingTier[],
): boolean {
  return (
    reference.length === candidate.length &&
    reference.every(
      (tier, index) => tier.min === candidate[index]?.min && tier.max === candidate[index]?.max,
    )
  );
}

function normalizeTieredPricing(
  pricing: VercelPricingShape | undefined,
  flatCost: ModelDefinitionConfig["cost"],
): NonNullable<ModelDefinitionConfig["cost"]["tieredPricing"]> | undefined {
  const inputTiers = parsePricingTierList(pricing?.input_tiers);
  const outputTiers = parsePricingTierList(pricing?.output_tiers);
  if (!inputTiers || !outputTiers || !pricingTierRangesMatch(inputTiers, outputTiers)) {
    return undefined;
  }

  const parsedCacheReadTiers = parsePricingTierList(pricing?.input_cache_read_tiers);
  const parsedCacheWriteTiers = parsePricingTierList(pricing?.input_cache_write_tiers);
  const cacheReadTiers =
    parsedCacheReadTiers && pricingTierRangesMatch(inputTiers, parsedCacheReadTiers)
      ? parsedCacheReadTiers
      : undefined;
  const cacheWriteTiers =
    parsedCacheWriteTiers && pricingTierRangesMatch(inputTiers, parsedCacheWriteTiers)
      ? parsedCacheWriteTiers
      : undefined;

  return inputTiers.map((tier, index) => {
    const range: [number, number] | [number] =
      tier.max === undefined ? [tier.min] : [tier.min, tier.max];
    return {
      input: tier.cost,
      output: outputTiers[index]?.cost ?? flatCost.output,
      cacheRead: cacheReadTiers?.[index]?.cost ?? flatCost.cacheRead,
      cacheWrite: cacheWriteTiers?.[index]?.cost ?? flatCost.cacheWrite,
      range,
    };
  });
}

function normalizeCost(pricing?: VercelPricingShape): ModelDefinitionConfig["cost"] {
  return {
    input: toPerMillionCost(pricing?.input),
    output: toPerMillionCost(pricing?.output),
    cacheRead: toPerMillionCost(pricing?.input_cache_read),
    cacheWrite: toPerMillionCost(pricing?.input_cache_write),
  };
}

function buildStaticModelDefinition(model: StaticVercelGatewayModel): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: {
      ...VERCEL_AI_GATEWAY_DEFAULT_COST,
      ...model.cost,
    },
  };
}

function getStaticFallbackModel(id: string): ModelDefinitionConfig | undefined {
  const fallback = STATIC_VERCEL_AI_GATEWAY_MODEL_CATALOG.find((model) => model.id === id);
  return fallback ? buildStaticModelDefinition(fallback) : undefined;
}

/** Builds runtime metadata for models returned by the live gateway catalog. */
export function resolveVercelAiGatewayDynamicModel(modelId: string): ModelDefinitionConfig {
  return (
    getStaticFallbackModel(modelId) ?? {
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text"],
      contextWindow: VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
      maxTokens: VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
      cost: VERCEL_AI_GATEWAY_DEFAULT_COST,
    }
  );
}

export function getStaticVercelAiGatewayModelCatalog(): ModelDefinitionConfig[] {
  return STATIC_VERCEL_AI_GATEWAY_MODEL_CATALOG.map(buildStaticModelDefinition);
}

function buildDiscoveredModelDefinition(value: unknown): ModelDefinitionConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Vercel AI Gateway model list: malformed JSON response");
  }
  const model = value as VercelGatewayModelShape;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id || (model.type !== undefined && model.type !== "language")) {
    return null;
  }

  const fallback = getStaticFallbackModel(id);
  const contextWindow =
    asPositiveSafeInteger(model.context_window) ??
    fallback?.contextWindow ??
    VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    asPositiveSafeInteger(model.max_tokens) ??
    fallback?.maxTokens ??
    VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS;
  const normalizedCost = normalizeCost(model.pricing);
  const tieredPricing = normalizeTieredPricing(model.pricing, normalizedCost);
  const hasLiveCost =
    normalizedCost.input > 0 ||
    normalizedCost.output > 0 ||
    normalizedCost.cacheRead > 0 ||
    normalizedCost.cacheWrite > 0 ||
    tieredPricing !== undefined;

  return {
    id,
    name: (typeof model.name === "string" ? model.name.trim() : "") || fallback?.name || id,
    reasoning:
      Array.isArray(model.tags) && model.tags.includes("reasoning")
        ? true
        : (fallback?.reasoning ?? false),
    input: Array.isArray(model.tags)
      ? model.tags.includes("vision")
        ? ["text", "image"]
        : ["text"]
      : (fallback?.input ?? ["text"]),
    contextWindow,
    maxTokens,
    cost: hasLiveCost
      ? { ...normalizedCost, ...(tieredPricing ? { tieredPricing } : {}) }
      : (fallback?.cost ?? VERCEL_AI_GATEWAY_DEFAULT_COST),
  };
}

export async function discoverVercelAiGatewayModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return getStaticVercelAiGatewayModelCatalog();
  }

  const provider = await buildLiveModelProviderConfig({
    providerId: VERCEL_AI_GATEWAY_PROVIDER_ID,
    endpoint: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    providerConfig: {
      baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
      api: "anthropic-messages",
    },
    models: getStaticVercelAiGatewayModelCatalog(),
    timeoutMs: VERCEL_AI_GATEWAY_DISCOVERY_TIMEOUT_MS,
    ttlMs: VERCEL_AI_GATEWAY_DISCOVERY_CACHE_TTL_MS,
    auditContext: "vercel-ai-gateway.models",
    fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
    projectRows: (rows) =>
      rows
        .map(buildDiscoveredModelDefinition)
        .filter((entry): entry is ModelDefinitionConfig => entry !== null),
  });
  return provider.models;
}
