import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildTokenHubModelDefinition,
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
} from "./models.js";

export function buildTokenHubProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKENHUB_BASE_URL,
    api: "openai-completions",
    models: TOKENHUB_MODEL_CATALOG.map(buildTokenHubModelDefinition),
  };
}
