// Minimax provider module implements model/runtime integration.
import { matchesExactOrPrefix } from "openclaw/plugin-sdk/provider-model-shared";

export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M3";
export const MINIMAX_DEFAULT_MODEL_REF = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;

export const MINIMAX_TEXT_MODEL_ORDER = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
] as const;

export const MINIMAX_TEXT_MODEL_CATALOG = {
  "MiniMax-M3": {
    name: "MiniMax M3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
  },
  "MiniMax-M2.7": {
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
  },
  "MiniMax-M2.7-highspeed": {
    name: "MiniMax M2.7 Highspeed",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
  },
} as const;

export const MINIMAX_TEXT_MODEL_REFS = MINIMAX_TEXT_MODEL_ORDER.map(
  (modelId) => `minimax/${modelId}`,
);

const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m3", "minimax-m2.7"] as const;

export function isMiniMaxModernModelId(modelId: string): boolean {
  return matchesExactOrPrefix(modelId, MINIMAX_MODERN_MODEL_MATCHERS);
}
