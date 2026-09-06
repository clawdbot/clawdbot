import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";

/**
 * Passthrough normalization for DeepInfra provider config.
 *
 * DeepInfra's OpenAI-compatible base URL is `https://api.deepinfra.com/v1/openai`
 * with the `/v1` segment mid-path, not at the end. The generic
 * openai-completions config normalizer strips a trailing `/v1` and re-appends
 * one, which is idempotent for providers like OpenRouter (`.../api/v1`) but
 * doubles to `.../v1/openai/v1` here and breaks inference (404).
 *
 * Shipping this bundled policy surface short-circuits the fallback normalizer
 * chain (see `src/plugins/provider-runtime.ts:normalizeProviderConfigWithPlugin`)
 * and preserves the DeepInfra-declared baseUrl as-is.
 */
export function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return params.providerConfig;
}
