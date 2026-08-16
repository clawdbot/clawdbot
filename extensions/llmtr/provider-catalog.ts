/**
 * LLMTR provider builders for static and dynamically discovered catalogs.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  LLMTR_BASE_URL,
  LLMTR_MODEL_CATALOG,
  buildLlmtrModelDefinition,
  discoverLlmtrModels,
} from "./models.js";

/** Builds the static LLMTR provider catalog from bundled model metadata. */
export function buildStaticLlmtrProvider(): ModelProviderConfig {
  return {
    baseUrl: LLMTR_BASE_URL,
    api: "openai-completions",
    models: LLMTR_MODEL_CATALOG.map(buildLlmtrModelDefinition),
  };
}

/**
 * Builds the LLMTR provider with dynamic model discovery, falling back to the
 * bundled catalog when the gateway is unreachable.
 */
export async function buildLlmtrProvider(apiKey?: string): Promise<ModelProviderConfig> {
  return {
    baseUrl: LLMTR_BASE_URL,
    api: "openai-completions",
    models: await discoverLlmtrModels(apiKey),
  };
}
