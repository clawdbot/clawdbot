// Mistral plugin module implements model definitions behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const MISTRAL_MANIFEST_CATALOG = manifest.modelCatalog.providers.mistral;

export const MISTRAL_BASE_URL = MISTRAL_MANIFEST_CATALOG.baseUrl;
export const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";

export function buildMistralModelDefinition(): ModelDefinitionConfig {
  const model = buildMistralCatalogModels().find((entry) => entry.id === MISTRAL_DEFAULT_MODEL_ID);
  if (!model) {
    throw new Error(`Missing Mistral provider model ${MISTRAL_DEFAULT_MODEL_ID}`);
  }
  return model;
}

function buildMistralCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "mistral",
    catalog: MISTRAL_MANIFEST_CATALOG,
  }).models;
}
