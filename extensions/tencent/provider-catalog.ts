// Tencent provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildTokenHubModelDefinition,
  buildTokenPlanModelDefinition,
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
  TOKENPLAN_BASE_URL,
  TOKENPLAN_MODEL_CATALOG,
} from "./models.js";

export function buildTokenHubProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKENHUB_BASE_URL,
    api: "openai-completions",
    models: TOKENHUB_MODEL_CATALOG.map(buildTokenHubModelDefinition),
  };
}

export function buildTokenPlanProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKENPLAN_BASE_URL,
    api: "openai-completions",
    models: TOKENPLAN_MODEL_CATALOG.map(buildTokenPlanModelDefinition),
  };
}
