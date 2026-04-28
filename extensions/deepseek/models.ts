import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPSEEK_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "deepseek",
  catalog: manifest.modelCatalog.providers.deepseek,
});

export const DEEPSEEK_BASE_URL = DEEPSEEK_MANIFEST_PROVIDER.baseUrl;

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = DEEPSEEK_MANIFEST_PROVIDER.models;

export function buildDeepSeekModelDefinition(
  model: (typeof DEEPSEEK_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
