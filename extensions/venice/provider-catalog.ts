// Venice provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { VENICE_BASE_URL, VENICE_MODEL_CATALOG } from "./models.js";

export function buildStaticVeniceProvider(): ModelProviderConfig {
  return {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models: structuredClone(VENICE_MODEL_CATALOG),
  };
}
