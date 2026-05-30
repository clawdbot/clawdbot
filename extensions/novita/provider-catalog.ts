import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { NOVITA_BASE_URL, NOVITA_MODEL_CATALOG, buildNovitaModelDefinition } from "./models.js";

export function buildNovitaProvider(): ModelProviderConfig {
  return {
    baseUrl: NOVITA_BASE_URL,
    api: "openai-completions",
    models: NOVITA_MODEL_CATALOG.map(buildNovitaModelDefinition),
  };
}
