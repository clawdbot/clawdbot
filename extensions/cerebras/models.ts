import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const CEREBRAS_MANIFEST_CATALOG = manifest.modelCatalog.providers.cerebras;

export const CEREBRAS_BASE_URL = CEREBRAS_MANIFEST_CATALOG.baseUrl;
export const CEREBRAS_MODEL_CATALOG = CEREBRAS_MANIFEST_CATALOG.models;

export function buildCerebrasCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "cerebras",
    catalog: CEREBRAS_MANIFEST_CATALOG,
  }).models;
}

export function buildCerebrasModelDefinition(
  model: (typeof CEREBRAS_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const providerConfig = buildManifestModelProviderConfig({
    providerId: "cerebras",
    catalog: { ...CEREBRAS_MANIFEST_CATALOG, models: [model] },
  });
  return providerConfig.models[0];
}
