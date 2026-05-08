import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const ARCEE_BASE_URL = "https://api.arcee.ai/api/v1";

export const ARCEE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "trinity-mini",
    name: "Trinity Mini 26B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 80000,
    cost: {
      input: 0.045,
      output: 0.15,
      cacheRead: 0.045,
      cacheWrite: 0.045,
    },
  },
  {
    id: "trinity-large-preview",
    name: "Trinity Large Preview",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: {
      input: 0.25,
      output: 1.0,
      cacheRead: 0.25,
      cacheWrite: 0.25,
    },
  },
  {
    id: "trinity-large-thinking",
    name: "Trinity Large Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 80000,
    cost: {
      input: 0.25,
      output: 0.9,
      cacheRead: 0.25,
      cacheWrite: 0.25,
    },
    compat: {
      supportsTools: false,
      supportsReasoningEffort: false,
    },
  },
];

export function buildArceeModelDefinition(
  model: (typeof ARCEE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}
