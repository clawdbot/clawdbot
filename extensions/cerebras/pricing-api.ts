import {
  normalizeModelPricingCatalog,
  normalizeOpenRouterModelPricing,
} from "openclaw/plugin-sdk/model-catalog-pricing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function parseCerebrasPricingCatalog(payload: unknown) {
  return normalizeModelPricingCatalog(
    asOptionalRecord(payload)?.data,
    normalizeOpenRouterModelPricing,
  );
}
