// Synthetic plugin module implements models behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";
export const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M3";
export const SYNTHETIC_DEFAULT_MODEL_REF = `synthetic/${SYNTHETIC_DEFAULT_MODEL_ID}`;
const SYNTHETIC_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const SYNTHETIC_MODEL_CATALOG = [
  {
    id: SYNTHETIC_DEFAULT_MODEL_ID,
    name: "MiniMax M3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "hf:moonshotai/Kimi-K2.7-Code",
    name: "Kimi K2.7 Code",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    name: "NVIDIA Nemotron 3 Super 120B A12B",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "hf:openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "hf:Qwen/Qwen3.6-27B",
    name: "Qwen3.6 27B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 81920,
  },
  {
    id: "hf:zai-org/GLM-4.7-Flash",
    name: "GLM-4.7 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 131072,
  },
  {
    id: "hf:zai-org/GLM-5.2",
    name: "GLM-5.2",
    reasoning: true,
    input: ["text"],
    contextWindow: 524288,
    maxTokens: 131072,
  },
] as const;

type SyntheticCatalogEntry = (typeof SYNTHETIC_MODEL_CATALOG)[number];

export function buildSyntheticModelDefinition(entry: SyntheticCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: SYNTHETIC_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
