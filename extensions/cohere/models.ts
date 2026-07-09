/**
 * Cohere model catalog helpers derived from the plugin manifest.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const COHERE_MANIFEST_CATALOG = manifest.modelCatalog.providers.cohere;

export const COHERE_BASE_URL = COHERE_MANIFEST_CATALOG.baseUrl;
export const COHERE_MODEL_CATALOG = COHERE_MANIFEST_CATALOG.models;
export const COHERE_COMMAND_A_PLUS_MODEL_ID = "command-a-plus-05-2026";
export const COHERE_COMMAND_A_REASONING_MODEL_ID = "command-a-reasoning-08-2025";
export const COHERE_COMMAND_A_VISION_MODEL_ID = "command-a-vision-07-2025";
export const COHERE_NORTH_MINI_CODE_MODEL_ID = "north-mini-code-1-0";

const COHERE_MODERN_MODEL_IDS = new Set([
  COHERE_COMMAND_A_PLUS_MODEL_ID,
  COHERE_COMMAND_A_REASONING_MODEL_ID,
  // Modern sweeps require agent tool use; Vision explicitly does not support tools.
  COHERE_NORTH_MINI_CODE_MODEL_ID,
]);

export function isModernCohereModelId(modelId: string): boolean {
  return COHERE_MODERN_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export function buildCohereCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "cohere",
    catalog: COHERE_MANIFEST_CATALOG,
  }).models;
}

export function buildCohereModelDefinition(
  model: (typeof COHERE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return buildManifestModelProviderConfig({
    providerId: "cohere",
    catalog: { ...COHERE_MANIFEST_CATALOG, models: [model] },
  }).models[0];
}
