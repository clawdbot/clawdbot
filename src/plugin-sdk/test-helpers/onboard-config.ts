// Onboard config test helpers build model/provider config fixtures for plugin tests.
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelApi } from "../provider-model-shared.js";

export const EXPECTED_FALLBACKS = ["anthropic/claude-opus-4-5"] as const;

export function createLegacyProviderConfig(params: {
  providerId: string;
  api: ModelApi;
  modelId?: string;
  modelName?: string;
  baseUrl?: string;
  apiKey?: string;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        [params.providerId]: {
          baseUrl: params.baseUrl ?? "https://old.example.com",
          apiKey: params.apiKey ?? "old-key",
          api: params.api,
          models: [
            {
              id: params.modelId ?? "old-model",
              name: params.modelName ?? "Old",
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 100,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

export function createConfigWithFallbacks(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { fallbacks: [...EXPECTED_FALLBACKS] },
      },
    },
  };
}
