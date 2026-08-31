import {
  asFiniteNumberInRange,
  asNonNegativeFiniteNumber,
  asPositiveSafeInteger,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { normalizeModelCatalogProviderId } from "./model-catalog-refs.js";
import type { ModelCatalogCost, ModelCatalogTieredCost } from "./model-catalog-types.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const MODEL_PRICING_SOURCES = [
  {
    id: "openCode",
    label: "OpenCode",
    url: "https://models.opencode.ai/api.json",
    authoritative: true,
  },
  {
    id: "venice",
    label: "Venice",
    url: "https://api.venice.ai/api/v1/models",
    authoritative: true,
  },
  {
    id: "chutes",
    label: "Chutes",
    url: "https://llm.chutes.ai/v1/models",
    authoritative: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    url: "https://api.cerebras.ai/public/v1/models",
    authoritative: true,
  },
  { id: "openRouter", label: "OpenRouter", url: OPENROUTER_MODELS_URL, authoritative: false },
  { id: "liteLLM", label: "LiteLLM", url: LITELLM_PRICING_URL, authoritative: false },
] as const;
export type ModelPricingSourceId = (typeof MODEL_PRICING_SOURCES)[number]["id"];
export type ModelPricingSource = {
  provider?: string;
  passthroughProviderModel?: boolean;
  modelIdTransforms?: "version-dots"[];
};
export type ModelPricingProvider = { external?: boolean } & Partial<
  Record<ModelPricingSourceId, ModelPricingSource | false>
>;

type CompleteModelCost = Omit<ModelCatalogTieredCost, "range"> &
  Pick<ModelCatalogCost, "tieredPricing">;
type ContextPrice = { size: number; cost: CompleteModelCost | undefined };

/** Normalize source policy without deciding which plugin owns the provider. */
export function normalizeModelPricingProvider(value: unknown): ModelPricingProvider | undefined {
  const record = asOptionalRecord(value);
  if (!record) {
    return undefined;
  }
  const policy: ModelPricingProvider =
    typeof record.external === "boolean" ? { external: record.external } : {};
  for (const { id: sourceId } of MODEL_PRICING_SOURCES) {
    const raw = record[sourceId];
    if (raw === false) {
      policy[sourceId] = false;
      continue;
    }
    const row = asOptionalRecord(raw);
    const provider = normalizeModelCatalogProviderId(normalizeOptionalString(row?.provider) ?? "");
    const modelIdTransforms = normalizeTrimmedStringList(row?.modelIdTransforms).filter(
      (entry): entry is "version-dots" => entry === "version-dots",
    );
    const source: ModelPricingSource = {
      ...(provider ? { provider } : {}),
      ...(row?.passthroughProviderModel === true ? { passthroughProviderModel: true } : {}),
      ...(modelIdTransforms.length > 0 ? { modelIdTransforms } : {}),
    };
    if (Object.keys(source).length > 0) {
      policy[sourceId] = source;
    }
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/** Keep unavailable prices distinct from malformed native catalogs and declared rates. */
export function normalizeModelPricingCatalog(
  rows: unknown,
  normalizePricing: (value: unknown) => CompleteModelCost | undefined,
  readPricing: (model: Record<string, unknown>) => unknown = (model) => model.pricing,
): Map<string, CompleteModelCost> | undefined {
  if (!Array.isArray(rows)) {
    return undefined;
  }
  const prices = new Map<string, CompleteModelCost>();
  const ids = new Set<string>();
  for (const value of rows) {
    const model = asOptionalRecord(value);
    const id = normalizeOptionalString(model?.id);
    if (!model || !id || ids.has(id)) {
      return undefined;
    }
    ids.add(id);
    const rawPricing = readPricing(model);
    if (rawPricing === undefined) {
      continue;
    }
    const pricing = normalizePricing(rawPricing);
    if (!pricing) {
      return undefined;
    }
    prices.set(id, pricing);
  }
  // An empty price feed cannot establish that every previously known price disappeared.
  return prices.size > 0 ? prices : undefined;
}

function readPricingCost(
  value: unknown,
  source: "openRouter" | "upstream",
): CompleteModelCost | undefined {
  const row = asOptionalRecord(value);
  const perToken = source === "openRouter";
  const fields = perToken
    ? ["prompt", "completion", "input_cache_read", "input_cache_write"]
    : ["input", "output", "cache_read", "cache_write"];
  const [input, output, cacheRead, cacheWrite] = fields.map((field, index) => {
    const raw = row?.[field];
    // Missing cache rates mean no cache charge; required rates must distinguish unknown from free.
    if (index >= 2 && raw === undefined) {
      return 0;
    }
    const rate = perToken ? parseStrictFiniteNumber(raw) : asNonNegativeFiniteNumber(raw);
    return rate === undefined
      ? undefined
      : asNonNegativeFiniteNumber(rate * (perToken ? 1_000_000 : 1));
  });
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

function withContextPrices(
  cost: CompleteModelCost | undefined,
  tiers: ContextPrice[],
): CompleteModelCost | undefined {
  if (!cost) {
    return undefined;
  }
  tiers.sort((left, right) => left.size - right.size);
  const firstTier = tiers[0];
  if (!firstTier) {
    return cost;
  }
  const tieredPricing: ModelCatalogTieredCost[] = [{ ...cost, range: [0, firstTier.size] }];
  for (const [index, tier] of tiers.entries()) {
    // A recognized context tier with unknown rates invalidates the price, not just that tier.
    if (!tier.cost) {
      return undefined;
    }
    const next = tiers[index + 1]?.size;
    // Conflicting thresholds cannot select one whole-request price; never publish zero-width tiers.
    if (next === tier.size) {
      return undefined;
    }
    tieredPricing.push({ ...tier.cost, range: next ? [tier.size, next] : [tier.size] });
  }
  return { ...cost, tieredPricing };
}

// OpenRouter's /models price keys include charge dimensions outside our four token rates.
// Keep this closed so unknown predicates cannot silently become unconditional prices.
const OPENROUTER_PRICE_FIELDS = new Set([
  "prompt",
  "completion",
  "request",
  "image",
  "web_search",
  "internal_reasoning",
  "input_cache_read",
  "input_cache_write",
  "audio",
  "input_audio_cache",
  "input_cache_write_1h",
  "image_output",
  "audio_output",
]);

/** Read native OpenRouter per-token prices and static prompt-length overrides. */
export function normalizeOpenRouterModelPricing(value: unknown): CompleteModelCost | undefined {
  const row = asOptionalRecord(value);
  const overrides: { size: number; prices: Record<string, unknown> }[] = [];
  for (const raw of Array.isArray(row?.overrides) ? row.overrides : []) {
    const override = asOptionalRecord(raw);
    // All predicates must match; UTC schedules and unknown conditions are not static tiers.
    if (
      !override ||
      Object.keys(override).some(
        (key) => key !== "min_prompt_tokens" && !OPENROUTER_PRICE_FIELDS.has(key),
      )
    ) {
      continue;
    }
    const threshold = asFiniteNumberInRange(override.min_prompt_tokens, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      maxExclusive: true,
    });
    if (threshold !== undefined) {
      overrides.push({ size: Math.floor(threshold) + 1, prices: override });
    }
  }
  // Token counts are integral and thresholds strict. Resolve every boundary from the
  // native base, then apply matching overrides per key in their original source order.
  const tiers = [...new Set(overrides.map(({ size }) => size))].map((size) => {
    const prices = { ...row };
    for (const override of overrides) {
      if (size >= override.size) {
        Object.assign(prices, override.prices);
      }
    }
    return { size, cost: readPricingCost(prices, "openRouter") };
  });
  return withContextPrices(readPricingCost(value, "openRouter"), tiers);
}

/** Read upstream per-million prices, preferring modern context tiers over context_over_200k. */
export function normalizeUpstreamModelPricing(value: unknown): CompleteModelCost | undefined {
  const row = asOptionalRecord(value);
  const tiers: ContextPrice[] = [];
  for (const raw of Array.isArray(row?.tiers) ? row.tiers : []) {
    const price = asOptionalRecord(raw);
    const tier = asOptionalRecord(price?.tier);
    const size = asPositiveSafeInteger(tier?.size);
    if (tier?.type === "context" && size) {
      tiers.push({ size, cost: readPricingCost(price, "upstream") });
    }
  }
  if (tiers.length === 0 && asOptionalRecord(row?.context_over_200k)) {
    tiers.push({ size: 200_000, cost: readPricingCost(row?.context_over_200k, "upstream") });
  }
  return withContextPrices(readPricingCost(value, "upstream"), tiers);
}
