import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const MISTRAL_MANIFEST_CATALOG = manifest.modelCatalog.providers.mistral;

export const MISTRAL_BASE_URL = MISTRAL_MANIFEST_CATALOG.baseUrl;
export const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";

function requireMistralManifestModel(id: string): (typeof MISTRAL_MANIFEST_CATALOG.models)[number] {
  const model = MISTRAL_MANIFEST_CATALOG.models.find((entry) => entry.id === id);
  if (!model) {
    throw new Error(`Missing Mistral modelCatalog row ${id}`);
  }
  return model;
}

const MISTRAL_DEFAULT_MANIFEST_MODEL = requireMistralManifestModel(MISTRAL_DEFAULT_MODEL_ID);

export const MISTRAL_DEFAULT_CONTEXT_WINDOW = MISTRAL_DEFAULT_MANIFEST_MODEL.contextWindow;
export const MISTRAL_DEFAULT_MAX_TOKENS = MISTRAL_DEFAULT_MANIFEST_MODEL.maxTokens;
export const MISTRAL_DEFAULT_COST = MISTRAL_DEFAULT_MANIFEST_MODEL.cost;

export function buildMistralModelDefinition(): ModelDefinitionConfig {
  const model = buildMistralCatalogModels().find((entry) => entry.id === MISTRAL_DEFAULT_MODEL_ID);
  if (!model) {
    throw new Error(`Missing Mistral provider model ${MISTRAL_DEFAULT_MODEL_ID}`);
  }
  return model;
}

export function buildMistralCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "mistral",
    catalog: MISTRAL_MANIFEST_CATALOG,
  }).models;
}
