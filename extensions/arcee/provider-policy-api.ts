import type { ProviderNormalizeModelCatalogIdContext } from "openclaw/plugin-sdk/provider-model-types";

/** Direct and OpenRouter wire ids identify the same logical Arcee catalog model. */
export function normalizeModelCatalogId({
  provider,
  modelId,
}: ProviderNormalizeModelCatalogIdContext) {
  if (provider.trim().toLowerCase() !== "arcee") {
    return undefined;
  }
  const id = modelId.trim();
  return id.startsWith("arcee-ai/") ? id.slice("arcee-ai/".length) : id;
}
