import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const FIREWORKS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "fireworks",
  catalog: manifest.modelCatalog.providers.fireworks,
});

export const FIREWORKS_BASE_URL = FIREWORKS_MANIFEST_PROVIDER.baseUrl;
export const FIREWORKS_DEFAULT_MODEL_ID = "accounts/fireworks/routers/kimi-k2p5-turbo";
export const FIREWORKS_K2_6_MODEL_ID = "accounts/fireworks/models/kimi-k2p6";

function requireFireworksManifestModel(id: string): ModelDefinitionConfig {
  const model = FIREWORKS_MANIFEST_PROVIDER.models.find((entry) => entry.id === id);
  if (!model) {
    throw new Error(`Missing Fireworks modelCatalog row ${id}`);
  }
  return model;
}

const FIREWORKS_DEFAULT_MODEL = requireFireworksManifestModel(FIREWORKS_DEFAULT_MODEL_ID);
const FIREWORKS_K2_6_MODEL = requireFireworksManifestModel(FIREWORKS_K2_6_MODEL_ID);

export const FIREWORKS_DEFAULT_CONTEXT_WINDOW = FIREWORKS_DEFAULT_MODEL.contextWindow;
export const FIREWORKS_DEFAULT_MAX_TOKENS = FIREWORKS_DEFAULT_MODEL.maxTokens;
export const FIREWORKS_K2_6_CONTEXT_WINDOW = FIREWORKS_K2_6_MODEL.contextWindow;
export const FIREWORKS_K2_6_MAX_TOKENS = FIREWORKS_K2_6_MODEL.maxTokens;

function cloneFireworksCatalogModel(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  };
}

export function buildFireworksCatalogModels(): ModelDefinitionConfig[] {
  return FIREWORKS_MANIFEST_PROVIDER.models.map(cloneFireworksCatalogModel);
}

export function buildFireworksProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "fireworks",
    catalog: manifest.modelCatalog.providers.fireworks,
  });
}
