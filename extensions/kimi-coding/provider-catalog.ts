import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const KIMI_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_USER_AGENT = "claude-code/0.1.0";
const KIMI_DEFAULT_MODEL_ID = "kimi-for-coding";
const KIMI_LEGACY_MODEL_IDS = ["kimi-code", "k2p5"] as const;
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;
const KIMI_CODING_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const KIMI_CODING_INPUT = ["text", "image"] satisfies NonNullable<ModelDefinitionConfig["input"]>;

export function buildKimiCodingProvider(): ModelProviderConfig {
  return {
    baseUrl: KIMI_BASE_URL,
    api: "anthropic-messages",
    headers: {
      "User-Agent": KIMI_CODING_USER_AGENT,
    },
    models: [
      {
        id: KIMI_DEFAULT_MODEL_ID,
        name: "Kimi Code",
        reasoning: true,
        input: [...KIMI_CODING_INPUT],
        cost: KIMI_CODING_DEFAULT_COST,
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      },
      ...KIMI_LEGACY_MODEL_IDS.map((id) => ({
        id,
        name: `Kimi Code (legacy ${id})`,
        reasoning: true,
        input: [...KIMI_CODING_INPUT],
        cost: KIMI_CODING_DEFAULT_COST,
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      })),
    ],
  };
}

export function normalizeKimiCodingModelId(modelId: string): string {
  return KIMI_LEGACY_MODEL_IDS.includes(modelId as (typeof KIMI_LEGACY_MODEL_IDS)[number])
    ? KIMI_DEFAULT_MODEL_ID
    : modelId;
}

export const KIMI_CODING_BASE_URL = KIMI_BASE_URL;
export const KIMI_CODING_DEFAULT_MODEL_ID = KIMI_DEFAULT_MODEL_ID;
export const KIMI_CODING_LEGACY_MODEL_IDS = KIMI_LEGACY_MODEL_IDS;
