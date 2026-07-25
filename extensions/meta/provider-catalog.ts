/**
 * Meta model provider builder.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildMetaCatalogModels, META_BASE_URL } from "./models.js";

/** Builds the Meta OpenAI-compatible model provider config. */
export function buildMetaProvider(): ModelProviderConfig {
  return {
    baseUrl: META_BASE_URL,
    api: "openai-responses",
    models: buildMetaCatalogModels(),
  };
}
