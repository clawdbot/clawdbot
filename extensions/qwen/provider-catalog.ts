import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildQwenModelCatalogForBaseUrl,
  buildQwenOAuthModelCatalog,
  QWEN_BASE_URL,
  QWEN_OAUTH_BASE_URL,
} from "./models.js";

export function buildQwenProvider(params?: { baseUrl?: string }): ModelProviderConfig {
  const baseUrl = params?.baseUrl ?? QWEN_BASE_URL;
  return {
    baseUrl,
    api: "openai-completions",
    models: buildQwenModelCatalogForBaseUrl(baseUrl).map((model) => Object.assign({}, model)),
  };
}

export function buildQwenOAuthProvider(): ModelProviderConfig {
  return {
    baseUrl: QWEN_OAUTH_BASE_URL,
    api: "openai-completions",
    models: buildQwenOAuthModelCatalog().map((model) => Object.assign({}, model)),
  };
}

export const buildModelStudioProvider = buildQwenProvider;
