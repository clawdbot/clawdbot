import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const NOVITA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "novita",
  catalog: manifest.modelCatalog.providers.novita,
});

export const NOVITA_BASE_URL = NOVITA_MANIFEST_PROVIDER.baseUrl;
export const NOVITA_MODEL_CATALOG: ModelDefinitionConfig[] = NOVITA_MANIFEST_PROVIDER.models;
export const NOVITA_DEFAULT_MODEL_REF = "novita/deepseek/deepseek-v3-0324";

export function buildNovitaModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
