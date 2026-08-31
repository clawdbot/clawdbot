/**
 * Mock OpenAI Responses provider used by gateway compatibility tests.
 */
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";

const MOCK_OPENAI_RESPONSES_PROVIDER_ID = "mock-openai";
type MockOpenAiResponsesProviderConfig = Omit<ModelProviderConfig, "models"> & {
  models: [ModelDefinitionConfig];
};

function buildOpenAiResponsesTestModel(id = "gpt-5.4"): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function buildOpenAiResponsesProviderConfig(
  baseUrl: string,
  modelId = "gpt-5.4",
): MockOpenAiResponsesProviderConfig {
  return {
    baseUrl,
    apiKey: "test",
    api: "openai-responses",
    models: [buildOpenAiResponsesTestModel(modelId)],
  };
}

/** Builds provider config and model refs for local OpenAI-compatible HTTP tests. */
export function buildMockOpenAiResponsesProvider(baseUrl: string, modelId = "gpt-5.4") {
  return {
    providerId: MOCK_OPENAI_RESPONSES_PROVIDER_ID,
    modelId,
    modelRef: `${MOCK_OPENAI_RESPONSES_PROVIDER_ID}/${modelId}`,
    config: buildOpenAiResponsesProviderConfig(baseUrl, modelId),
  } as const;
}
