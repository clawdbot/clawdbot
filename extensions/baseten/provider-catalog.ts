/** Baseten static and authenticated provider catalog builders. */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { BASETEN_BASE_URL, buildStaticBasetenModels, discoverBasetenModels } from "./models.js";

/** Builds Baseten's network-free fallback provider catalog. */
export function buildStaticBasetenProvider(): ModelProviderConfig {
  return {
    baseUrl: BASETEN_BASE_URL,
    api: "openai-completions",
    models: buildStaticBasetenModels(),
  };
}

/** Builds Baseten's account-scoped live catalog. */
export async function buildBasetenProvider(discoveryApiKey?: string): Promise<ModelProviderConfig> {
  return {
    baseUrl: BASETEN_BASE_URL,
    api: "openai-completions",
    models: await discoverBasetenModels({ discoveryApiKey }),
  };
}
