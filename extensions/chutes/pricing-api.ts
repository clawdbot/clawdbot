import { normalizeModelPricingCatalog } from "openclaw/plugin-sdk/model-catalog-pricing";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { asFiniteNumberInRange, asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Chutes publishes numeric USD-per-million rates, not OpenRouter's per-token strings. */
export function normalizeChutesModelPricing(
  value: unknown,
): ModelDefinitionConfig["cost"] | undefined {
  const pricing = asOptionalRecord(value);
  const input = asFiniteNumberInRange(pricing?.prompt, { min: 0 });
  const output = asFiniteNumberInRange(pricing?.completion, { min: 0 });
  const cacheRead =
    pricing?.input_cache_read === undefined
      ? 0
      : asFiniteNumberInRange(pricing.input_cache_read, { min: 0 });
  if (input === undefined || output === undefined || cacheRead === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite: 0 };
}

export function parseChutesPricingCatalog(payload: unknown) {
  return normalizeModelPricingCatalog(asOptionalRecord(payload)?.data, normalizeChutesModelPricing);
}
