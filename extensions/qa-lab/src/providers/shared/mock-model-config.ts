import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const ZERO_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

function cloneProvider(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  };
}

export function trimTrailingApiV1(baseUrl: string) {
  return baseUrl.replace(/\/v1\/?$/i, "");
}

export function createMockOpenAiResponsesProvider(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl,
    apiKey: "test",
    api: "openai-responses",
    request: {
      allowPrivateNetwork: true,
    },
    models: [
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-5.4-alt",
        name: "gpt-5.4-alt",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-image-1",
        name: "gpt-image-1",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  };
}

export function createMockAnthropicMessagesProvider(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: trimTrailingApiV1(baseUrl),
    apiKey: "test",
    api: "anthropic-messages",
    request: {
      allowPrivateNetwork: true,
    },
    models: [
      {
        id: "claude-opus-4-6",
        name: "claude-opus-4-6",
        api: "anthropic-messages",
        reasoning: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 200_000,
        maxTokens: 4096,
      },
      {
        id: "claude-sonnet-4-6",
        name: "claude-sonnet-4-6",
        api: "anthropic-messages",
        reasoning: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  };
}

export function createMockProviderMap(primaryProviderId: string, providerBaseUrl: string) {
  const primaryProvider = createMockOpenAiResponsesProvider(providerBaseUrl);
  return {
    [primaryProviderId]: primaryProvider,
    openai: cloneProvider(primaryProvider),
    anthropic: createMockAnthropicMessagesProvider(providerBaseUrl),
  };
}
