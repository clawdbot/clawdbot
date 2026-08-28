import type { ProviderNormalizeConfigContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLmstudioTransportReasoningCompat } from "./src/model-reasoning.js";

/** Normalize saved reasoning metadata without activating provider runtime or changing transport. */
export function normalizeConfig({ provider, providerConfig }: ProviderNormalizeConfigContext) {
  if (provider.trim().toLowerCase() !== "lmstudio" || !Array.isArray(providerConfig.models)) {
    return providerConfig;
  }
  const models = providerConfig.models.map((model) => {
    const compat = model.compat;
    if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
      return model;
    }
    const normalized = normalizeLmstudioTransportReasoningCompat(compat);
    return normalized === compat ? model : { ...model, compat: normalized };
  });
  return models.some((model, index) => model !== providerConfig.models[index])
    ? { ...providerConfig, models }
    : providerConfig;
}
