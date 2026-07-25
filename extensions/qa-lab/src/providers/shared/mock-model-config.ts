// Qa Lab helper module supports mock model config behavior.
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

function trimTrailingApiV1(baseUrl: string) {
  return baseUrl.replace(/\/v1\/?$/i, "");
}

const DEFAULT_OPENAI_MODEL_IDS = ["gpt-5.6-luna", "gpt-5.6-luna-alt"] as const;

function selectedOpenAiModelIds(
  primaryProviderId: string,
  selectedModelRefs: readonly (string | undefined)[],
) {
  const selected = selectedModelRefs.flatMap((modelRef) => {
    const slash = modelRef?.indexOf("/") ?? -1;
    if (!modelRef || slash <= 0 || slash === modelRef.length - 1) {
      return [];
    }
    const providerId = modelRef.slice(0, slash);
    return providerId === primaryProviderId || providerId === "openai"
      ? [modelRef.slice(slash + 1)]
      : [];
  });
  return selected.length > 0 ? [...new Set(selected)] : [...DEFAULT_OPENAI_MODEL_IDS];
}

function createMockOpenAiTextModel(id: string): ModelProviderConfig["models"][number] {
  return {
    id,
    name: id,
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function createMockOpenAiResponsesProvider(
  baseUrl: string,
  modelIds: readonly string[],
): ModelProviderConfig {
  return {
    baseUrl,
    apiKey: "test",
    api: "openai-responses",
    request: {
      allowPrivateNetwork: true,
    },
    models: [
      ...modelIds.map(createMockOpenAiTextModel),
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

function createMockAnthropicMessagesProvider(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: trimTrailingApiV1(baseUrl),
    apiKey: "test",
    api: "anthropic-messages",
    request: {
      allowPrivateNetwork: true,
    },
    models: [
      {
        id: "claude-opus-4-8",
        name: "claude-opus-4-8",
        api: "anthropic-messages",
        reasoning: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 1_048_576,
        maxTokens: 128_000,
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

export function createMockProviderMap(
  primaryProviderId: string,
  providerBaseUrl: string,
  selectedModelRefs: readonly (string | undefined)[] = [],
) {
  const primaryProvider = createMockOpenAiResponsesProvider(
    providerBaseUrl,
    selectedOpenAiModelIds(primaryProviderId, selectedModelRefs),
  );
  return {
    [primaryProviderId]: primaryProvider,
    openai: cloneProvider(primaryProvider),
    anthropic: createMockAnthropicMessagesProvider(providerBaseUrl),
  };
}

export function listMockOpenAiServerModelIds(selectedModelRefs: readonly string[] = []) {
  return [
    ...selectedOpenAiModelIds("mock-openai", selectedModelRefs),
    "gpt-image-1",
    "gpt-4o-transcribe",
    "text-embedding-3-small",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
  ];
}
