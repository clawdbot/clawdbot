import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildCerebrasCatalogModels, CEREBRAS_BASE_URL } from "./models.js";

export function buildCerebrasProvider(): ModelProviderConfig {
  return {
    baseUrl: CEREBRAS_BASE_URL,
    api: "openai-completions",
    models: buildCerebrasCatalogModels(),
  };
}
