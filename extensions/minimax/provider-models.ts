import { matchesExactOrPrefix } from "openclaw/plugin-sdk/provider-model-shared";

export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.7";
export const MINIMAX_DEFAULT_MODEL_REF = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;

export const MINIMAX_TEXT_MODEL_ORDER = ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"] as const;

export const MINIMAX_TEXT_MODEL_CATALOG = {
  "MiniMax-M2.7": { name: "MiniMax M2.7", reasoning: true },
  "MiniMax-M2.7-highspeed": { name: "MiniMax M2.7 Highspeed", reasoning: true },
} as const;

export const MINIMAX_TEXT_MODEL_REFS = MINIMAX_TEXT_MODEL_ORDER.map(
  (modelId) => `minimax/${modelId}`,
);

const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;

export function isMiniMaxModernModelId(modelId: string): boolean {
  return matchesExactOrPrefix(modelId, MINIMAX_MODERN_MODEL_MATCHERS);
}
