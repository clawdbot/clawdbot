// Kimi Coding provider module implements model/runtime integration.
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { KIMI_K3_MODEL_IDS } from "./provider-policy-api.js";

const KIMI_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_USER_AGENT = "claude-code/0.1.0";
const KIMI_DEFAULT_MODEL_ID = "kimi-for-coding";
const KIMI_HIGHSPEED_MODEL_ID = "kimi-for-coding-highspeed";
const KIMI_LEGACY_MODEL_IDS = ["kimi-code", "k2p5"] as const;
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;
const KIMI_CODING_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const KIMI_K3_COST = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 0,
};
// k3 serves up to 1M context, tier-gated server-side; k3-256k is the cheaper 256K variant.
// Legacy k3[1m] was retired upstream and normalizes to k3 for shipped configurations.
const KIMI_K3_CONTEXT_WINDOW = 1_048_576;
const KIMI_K3_MAX_TOKENS = 131_072;
const KIMI_K3_THINKING_LEVEL_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} satisfies NonNullable<ModelDefinitionConfig["thinkingLevelMap"]>;
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
      {
        id: KIMI_HIGHSPEED_MODEL_ID,
        name: "Kimi K2.7 Code HighSpeed",
        reasoning: true,
        input: [...KIMI_CODING_INPUT],
        cost: KIMI_CODING_DEFAULT_COST,
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      },
      ...KIMI_K3_MODEL_IDS.map((id) => ({
        id,
        name: id === "k3" ? "Kimi K3" : "Kimi K3 (256k)",
        reasoning: true,
        thinkingLevelMap: { ...KIMI_K3_THINKING_LEVEL_MAP },
        input: [...KIMI_CODING_INPUT],
        cost: KIMI_K3_COST,
        contextWindow: id === "k3" ? KIMI_K3_CONTEXT_WINDOW : KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_K3_MAX_TOKENS,
      })),
    ],
  };
}

export function normalizeKimiCodingModelId(modelId: string): string {
  if (modelId === "k3[1m]") {
    return "k3";
  }
  return KIMI_LEGACY_MODEL_IDS.includes(modelId as (typeof KIMI_LEGACY_MODEL_IDS)[number])
    ? KIMI_DEFAULT_MODEL_ID
    : modelId;
}

export const KIMI_CODING_BASE_URL = KIMI_BASE_URL;
export const KIMI_CODING_DEFAULT_MODEL_ID = KIMI_DEFAULT_MODEL_ID;
export const KIMI_CODING_LEGACY_MODEL_IDS = KIMI_LEGACY_MODEL_IDS;
