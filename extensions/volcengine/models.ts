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
export const DOUBAO_DEFAULT_MODEL_ID = "doubao-seed-1-8-251228";
export const DOUBAO_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export const DOUBAO_DEFAULT_MODEL_REF = `volcengine/${DOUBAO_DEFAULT_MODEL_ID}`;

export const DOUBAO_DEFAULT_COST = {
  input: 0.0001,
  output: 0.0002,
  cacheRead: 0,
  cacheWrite: 0,
};

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
