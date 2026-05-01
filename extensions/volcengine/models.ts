import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DOUBAO_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "volcengine",
  catalog: manifest.modelCatalog.providers.volcengine,
});

const DOUBAO_CODING_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "volcengine-plan",
  catalog: manifest.modelCatalog.providers["volcengine-plan"],
});

export const DOUBAO_BASE_URL = DOUBAO_MANIFEST_PROVIDER.baseUrl;
export const DOUBAO_CODING_BASE_URL = DOUBAO_CODING_MANIFEST_PROVIDER.baseUrl;

export const DOUBAO_MODEL_CATALOG: ModelDefinitionConfig[] = DOUBAO_MANIFEST_PROVIDER.models;
export const DOUBAO_CODING_MODEL_CATALOG: ModelDefinitionConfig[] =
  DOUBAO_CODING_MANIFEST_PROVIDER.models;

export function buildDoubaoModelDefinition(entry: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...entry,
    input: [...entry.input],
    cost: { ...entry.cost },
  };
}
