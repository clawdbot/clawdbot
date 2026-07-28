/**
 * Apiário provider catalog builders.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildApiarioModelDefinition, APIARIO_BASE_URL, APIARIO_MODEL_CATALOG } from "./models.js";

/** Build Apiário catalog models. */
export function buildApiarioCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return APIARIO_MODEL_CATALOG.map(buildApiarioModelDefinition);
}

/** Build the Apiário provider config. */
export function buildApiarioProvider(): ModelProviderConfig {
  return {
    baseUrl: APIARIO_BASE_URL,
    api: "openai-completions",
    models: buildApiarioCatalogModels(),
  };
}
