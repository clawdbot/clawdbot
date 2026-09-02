import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildMistralProvider } from "./provider-catalog.js";

const MISTRAL_MANIFEST_CATALOG = manifest.modelCatalog.providers.mistral;

export const MISTRAL_BASE_URL = MISTRAL_MANIFEST_CATALOG.baseUrl;
export const MISTRAL_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "mistral")!;
export const MISTRAL_DEFAULT_MODEL_ID = MISTRAL_DEFAULT_MODEL_REF.slice("mistral/".length);

export function buildMistralModelDefinition(): ModelDefinitionConfig {
  const model = buildMistralProvider().models.find(
    (entry) => entry.id === MISTRAL_DEFAULT_MODEL_ID,
  );
  if (!model) {
    throw new Error(`Missing Mistral provider model ${MISTRAL_DEFAULT_MODEL_ID}`);
  }
  return model;
}
