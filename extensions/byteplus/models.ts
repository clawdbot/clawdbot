import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const BYTEPLUS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "byteplus",
  catalog: manifest.modelCatalog.providers.byteplus,
});

const BYTEPLUS_CODING_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "byteplus-plan",
  catalog: manifest.modelCatalog.providers["byteplus-plan"],
});

export const BYTEPLUS_BASE_URL = BYTEPLUS_MANIFEST_PROVIDER.baseUrl;
export const BYTEPLUS_CODING_BASE_URL = BYTEPLUS_CODING_MANIFEST_PROVIDER.baseUrl;

export const BYTEPLUS_DEFAULT_COST = {
  input: 0.0001,
  output: 0.0002,
  cacheRead: 0,
  cacheWrite: 0,
};

export const BYTEPLUS_MODEL_CATALOG: ModelDefinitionConfig[] = BYTEPLUS_MANIFEST_PROVIDER.models;
export const BYTEPLUS_CODING_MODEL_CATALOG: ModelDefinitionConfig[] =
  BYTEPLUS_CODING_MANIFEST_PROVIDER.models;

export function buildBytePlusModelDefinition(entry: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...entry,
    input: [...entry.input],
    cost: { ...entry.cost },
  };
}
