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

/** Codex consumes full model metadata, while OpenAI clients consume the sibling `data` list. */
export function listMockCodexModelInfos(selectedModelRefs: readonly string[] = []) {
  return selectedOpenAiModelIds("mock-openai", selectedModelRefs).map((slug, priority) => ({
    slug,
    display_name: slug,
    description: "QA mock OpenAI coding model",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast QA reasoning" },
      { effort: "medium", description: "Balanced QA reasoning" },
      { effort: "high", description: "Thorough QA reasoning" },
      { effort: "xhigh", description: "Extra-thorough QA reasoning" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    include_skills_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 128_000,
    max_context_window: 128_000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    tool_mode: "direct",
  }));
}
