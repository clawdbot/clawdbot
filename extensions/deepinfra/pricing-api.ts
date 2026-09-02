import { normalizeModelPricingCatalog } from "openclaw/plugin-sdk/model-catalog-pricing";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  asPositiveSafeInteger,
} from "openclaw/plugin-sdk/string-coerce-runtime";

function normalizeDeepInfraTokenPricing(value: unknown): ModelDefinitionConfig["cost"] | undefined {
  const row = asOptionalRecord(value);
  if (!row || (row.type !== undefined && row.type !== "tokens")) {
    return undefined;
  }
  const discount = asFiniteNumberInRange(row.discount ?? 0, { min: 0, max: 1 });
  const inputCents = asFiniteNumberInRange(row.cents_per_input_token, { min: 0 });
  const outputCents = asFiniteNumberInRange(row.cents_per_output_token, { min: 0 });
  const cacheRatio = asFiniteNumberInRange(row.rate_per_input_token_cached ?? 0, { min: 0 });
  const table = row.table == null ? undefined : asOptionalRecord(row.table);
  const explicitWrites = row.rate_per_explicit_cache_write_token;
  const writeRates = explicitWrites == null ? undefined : asOptionalRecord(explicitWrites);
  if (
    discount === undefined ||
    inputCents === undefined ||
    outputCents === undefined ||
    cacheRatio === undefined ||
    (row.full != null && typeof row.full !== "string") ||
    (row.table != null && !table) ||
    (row.discount_ends_at != null && !Number.isSafeInteger(row.discount_ends_at)) ||
    [
      "rate_per_input_token_cache_write",
      "rate_per_service_tier_priority",
      "rate_per_service_tier_flex",
    ].some(
      (key) => row[key] != null && asFiniteNumberInRange(row[key], { min: 0 }) === undefined,
    ) ||
    (explicitWrites != null &&
      (!writeRates ||
        Object.values(writeRates).some(
          (rate) => asFiniteNumberInRange(rate, { min: 0 }) === undefined,
        ))) ||
    (row.explicit_cache_granularity_tokens != null &&
      asPositiveSafeInteger(row.explicit_cache_granularity_tokens) === undefined)
  ) {
    return undefined;
  }
  // Native cents/token become USD/M; the documented discount applies once to all charges.
  // DeepInfra's public pricing renderer multiplies cached input by this input-price ratio.
  const input = inputCents * 10_000 * (1 - discount);
  const output = outputCents * 10_000 * (1 - discount);
  const cacheRead = input * cacheRatio;
  return [input, output, cacheRead].every(Number.isFinite)
    ? { input, output, cacheRead, cacheWrite: 0 }
    : undefined;
}

/** Pure native price owner shared by hosted publication and chat discovery. */
export function parseDeepInfraPricingCatalog(payload: unknown) {
  return normalizeModelPricingCatalog(payload, normalizeDeepInfraTokenPricing, {
    readModelId: (model) => model.model_name,
    readPricing: (model) => {
      const pricing = asOptionalRecord(model.pricing);
      // Other native domains (images, time, embeddings) are not malformed chat token prices.
      return typeof pricing?.type === "string" && pricing.type !== "tokens"
        ? undefined
        : model.pricing;
    },
    isSupportedPricing: (value) => {
      const row = asOptionalRecord(value);
      // Prose, tables, and expiry cannot establish an unconditional schedule. Retention and
      // service-tier multipliers are separate contracts; generic cache-write semantics remain undocumented.
      return (
        row !== undefined &&
        !row.full &&
        Object.keys(asOptionalRecord(row.table) ?? {}).length === 0 &&
        row.discount_ends_at == null &&
        row.rate_per_input_token_cache_write == null
      );
    },
  });
}
