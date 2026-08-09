// Qwen provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildQwenModelCatalogForBaseUrl,
  QWEN_BASE_URL,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  QWEN_TOKEN_PLAN_MODEL_CATALOG,
} from "./models.js";

export function buildQwenProvider(params?: { baseUrl?: string }): ModelProviderConfig {
  const baseUrl = params?.baseUrl ?? QWEN_BASE_URL;
  return {
    baseUrl,
    api: "openai-completions",
    models: buildQwenModelCatalogForBaseUrl(baseUrl).map((model) => Object.assign({}, model)),
  };
}

export function buildQwenTokenPlanProvider(params?: { baseUrl?: string }): ModelProviderConfig {
  const baseUrl = params?.baseUrl ?? QWEN_TOKEN_PLAN_GLOBAL_BASE_URL;
  return {
    baseUrl,
    api: "openai-completions",
    models: QWEN_TOKEN_PLAN_MODEL_CATALOG.map((model) => Object.assign({}, model)),
  };
}

export const buildModelStudioProvider = buildQwenProvider;
