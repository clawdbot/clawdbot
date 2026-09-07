import { normalizeModelPricingCatalog } from "openclaw/plugin-sdk/model-catalog-pricing";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { asFiniteNumberInRange, asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function readVeniceRates(value: unknown): ModelDefinitionConfig["cost"] | undefined {
  const row = asOptionalRecord(value);
  const [input, output, cacheRead, cacheWrite] = [
    "input",
    "output",
    "cache_input",
    "cache_write",
  ].map((field, index) => {
    // Venice omits cache prices when caching is unsupported or writes are not charged.
    if (index >= 2 && row?.[field] === undefined) {
      return 0;
    }
    return asFiniteNumberInRange(asOptionalRecord(row?.[field])?.usd, { min: 0 });
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

/** Venice's public /models prices are USD per million tokens, for the whole request. */
export function parseVeniceModelPricing(value: unknown): ModelDefinitionConfig["cost"] | undefined {
  const row = asOptionalRecord(value);
  const base = readVeniceRates(row);
  if (!base || row?.extended === undefined) {
    return base;
  }
  const extended = asOptionalRecord(row.extended);
  const rates = readVeniceRates(extended);
  const threshold = asFiniteNumberInRange(extended?.context_token_threshold, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    maxExclusive: true,
  });
  if (!rates || threshold === undefined) {
    return undefined;
  }
  // A missing extended cache price cannot establish the charge for a supported
  // cache bucket. Reject the schedule instead of borrowing its base rate.
  if (
    ["cache_input", "cache_write"].some(
      (field) => row[field] !== undefined && extended?.[field] === undefined,
    )
  ) {
    return undefined;
  }
  // Token counts are integral; Venice switches strictly above the threshold.
  const start = Math.floor(threshold) + 1;
  return {
    ...base,
    tieredPricing: [
      { ...base, range: [0, start] },
      { ...rates, range: [start] },
    ],
  };
}

/** Public lightweight publisher entrypoint; vendor payload interpretation stays in this plugin. */
export function parseVenicePricingCatalog(
  payload: unknown,
): Map<string, ModelDefinitionConfig["cost"]> | undefined {
  return normalizeModelPricingCatalog(asOptionalRecord(payload)?.data, parseVeniceModelPricing, {
    readPricing: (model) =>
      model.type === "text" ? asOptionalRecord(model.model_spec)?.pricing : undefined,
  });
}
