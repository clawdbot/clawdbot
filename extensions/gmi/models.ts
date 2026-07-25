// Gmi plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const GMI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "gmi",
  catalog: manifest.modelCatalog.providers.gmi,
});

export const GMI_BASE_URL = GMI_MANIFEST_PROVIDER.baseUrl;
export const GMI_MODEL_CATALOG: ModelDefinitionConfig[] = GMI_MANIFEST_PROVIDER.models;
export const GMI_DEFAULT_MODEL_REF = "gmi/openai/gpt-5.6-sol";

export function buildGmiModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
