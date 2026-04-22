import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  CHUTES_BASE_URL,
  CHUTES_MODEL_CATALOG,
  buildChutesModelDefinition,
  discoverChutesModels,
} from "./models.js";

export function buildStaticChutesProvider(): ModelProviderConfig {
  return {
    baseUrl: CHUTES_BASE_URL,
    api: "openai-completions",
    models: CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
  };
}

/**
 * Build the Chutes provider with dynamic model discovery.
 * Falls back to the static catalog on failure.
 * Accepts an optional access token (API key or OAuth access token) for authenticated discovery.
 */
export async function buildChutesProvider(accessToken?: string): Promise<ModelProviderConfig> {
  const models = await discoverChutesModels(accessToken);
  return {
    baseUrl: CHUTES_BASE_URL,
    api: "openai-completions",
    models: models.length > 0 ? models : CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
  };
}
