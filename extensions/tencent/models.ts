import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

// ---------- TokenHub provider ----------

export const TOKENHUB_BASE_URL = "https://tokenhub.tencentmaas.com/v1";
export const TOKENHUB_PROVIDER_ID = "tencent-tokenhub";

// Hy3 preview pricing ($ per 1M tokens), tiered by input context length.
// Flat rates mirror the first tier; tieredPricing drives actual cost calculation.
const HY3_PREVIEW_COST = {
  input: 0.176,
  output: 0.587,
  cacheRead: 0.059,
  cacheWrite: 0,
  tieredPricing: [
    {
      input: 0.176,
      output: 0.587,
      cacheRead: 0.059,
      cacheWrite: 0,
      range: [0, 16_000] as [number, number],
    },
    {
      input: 0.235,
      output: 0.939,
      cacheRead: 0.088,
      cacheWrite: 0,
      range: [16_000, 32_000] as [number, number],
    },
    {
      input: 0.293,
      output: 1.173,
      cacheRead: 0.117,
      cacheWrite: 0,
      range: [32_000] as [number],
    },
  ],
};

export const TOKENHUB_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "hy3-preview",
    name: "Hy3 preview (TokenHub)",
    reasoning: true,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 64_000,
    cost: HY3_PREVIEW_COST,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
    },
  },
];

export function buildTokenHubModelDefinition(
  model: (typeof TOKENHUB_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
