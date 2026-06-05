// Gmi provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { GMI_BASE_URL, GMI_MODEL_CATALOG, buildGmiModelDefinition } from "./models.js";

export function buildGmiProvider(): ModelProviderConfig {
  return {
    baseUrl: GMI_BASE_URL,
    api: "openai-completions",
    models: GMI_MODEL_CATALOG.map(buildGmiModelDefinition),
  };
}
