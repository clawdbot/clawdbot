import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const TOGETHER_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "together",
  catalog: manifest.modelCatalog.providers.together,
});

export const TOGETHER_BASE_URL = TOGETHER_MANIFEST_PROVIDER.baseUrl;

export const TOGETHER_MODEL_CATALOG: ModelDefinitionConfig[] = TOGETHER_MANIFEST_PROVIDER.models;

export function buildTogetherModelDefinition(
  model: (typeof TOGETHER_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
    input: [...model.input],
    cost: { ...model.cost },
  };
}
