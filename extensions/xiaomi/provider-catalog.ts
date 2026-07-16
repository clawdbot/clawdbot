import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/v1";
export const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
const XIAOMI_DEFAULT_CONTEXT_WINDOW = 262144;
const XIAOMI_DEFAULT_MAX_TOKENS = 8192;
const XIAOMI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildXiaomiProvider(): ModelProviderConfig {
  return {
    baseUrl: XIAOMI_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: XIAOMI_DEFAULT_MODEL_ID,
        name: "Xiaomi MiMo V2 Flash",
        reasoning: false,
        input: ["text"],
        cost: XIAOMI_DEFAULT_COST,
        contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
        maxTokens: XIAOMI_DEFAULT_MAX_TOKENS,
      },
      {
        id: "mimo-v2-pro",
        name: "Xiaomi MiMo V2 Pro",
        reasoning: true,
        input: ["text"],
        cost: XIAOMI_DEFAULT_COST,
        contextWindow: 1048576,
        maxTokens: 32000,
      },
      {
        id: "mimo-v2-omni",
        name: "Xiaomi MiMo V2 Omni",
        reasoning: true,
        input: ["text", "image"],
        cost: XIAOMI_DEFAULT_COST,
        contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
        maxTokens: 32000,
      },
    ],
  };
}
