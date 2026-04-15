import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b";
const NVIDIA_DEFAULT_MAX_TOKENS = 8192;
const NVIDIA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildNvidiaProvider(): ModelProviderConfig {
  return {
    baseUrl: NVIDIA_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: NVIDIA_DEFAULT_MODEL_ID,
        name: "NVIDIA Nemotron 3 Super 120B",
        reasoning: false,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: 262144,
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
      },
      {
        id: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
        reasoning: false,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: 262144,
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
      },
      {
        id: "minimaxai/minimax-m2.5",
        name: "MiniMax M2.5",
        reasoning: false,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: 196608,
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
      },
      {
        id: "z-ai/glm5",
        name: "GLM-5",
        reasoning: false,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: 202752,
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
