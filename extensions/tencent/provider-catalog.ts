// Tencent provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
  TOKENPLAN_BASE_URL,
  TOKENPLAN_MODEL_CATALOG,
} from "./models.js";

export function buildTokenHubProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKENHUB_BASE_URL,
    api: "openai-completions",
    models: structuredClone(TOKENHUB_MODEL_CATALOG),
  };
}

export function buildTokenPlanProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKENPLAN_BASE_URL,
    api: "openai-completions",
    models: structuredClone(TOKENPLAN_MODEL_CATALOG),
  };
}
