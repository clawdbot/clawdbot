/**
 * Chutes provider builders for static and dynamically discovered catalogs.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { CHUTES_BASE_URL, CHUTES_MODEL_CATALOG, discoverChutesModels } from "./models.js";

/** Builds the static Chutes provider catalog from bundled model metadata. */
export function buildStaticChutesProvider(): ModelProviderConfig {
  return {
    baseUrl: CHUTES_BASE_URL,
    api: "openai-completions",
    models: structuredClone(CHUTES_MODEL_CATALOG),
  };
}

/**
 * Build the Chutes provider with dynamic model discovery.
 * Accepts an optional access token (API key or OAuth access token) for authenticated discovery.
 */
export async function buildChutesProvider(
  accessToken?: string,
  options: { discoveryMode?: "strict" } = {},
): Promise<ModelProviderConfig> {
  return {
    baseUrl: CHUTES_BASE_URL,
    api: "openai-completions",
    models: await discoverChutesModels(accessToken, options),
  };
}
