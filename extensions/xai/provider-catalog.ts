import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildXaiCatalogModels, XAI_BASE_URL } from "./model-definitions.js";

export function buildXaiProvider(
  api: ModelProviderConfig["api"] = "openai-responses",
): ModelProviderConfig {
  return {
    baseUrl: XAI_BASE_URL,
    api,
    models: buildXaiCatalogModels(),
  };
}
