// WRouter provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { WROUTER_BASE_URL, WROUTER_MODEL_CATALOG } from "./models.js";

export function buildWRouterProvider(): ModelProviderConfig {
  return {
    baseUrl: WROUTER_BASE_URL,
    api: "openai-completions",
    models: structuredClone(WROUTER_MODEL_CATALOG),
  };
}
