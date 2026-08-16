/**
 * Reads normalized context-token metadata from resolved model definitions.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { Model } from "../../llm/types.js";

/**
 * Reads optional context-token metadata from discovered models without widening the core model type.
 */
type AgentModelWithOptionalContextTokens = Model & {
  contextTokens?: number;
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Returns finite context-token metadata when a model discovery source provided it. */
/** Prefer contextTokens, then contextWindow, when present on model metadata. */
export function readAgentModelContextTokens(model: Model | null | undefined): number | undefined {
  const cast = model as AgentModelWithOptionalContextTokens | null | undefined;
  const contextTokens = asFiniteNumber(cast?.contextTokens);
  if (contextTokens !== undefined && contextTokens > 0) {
    return contextTokens;
  }
  const contextWindow = asFiniteNumber((cast as Model & { contextWindow?: number })?.contextWindow);
  if (contextWindow !== undefined && contextWindow > 0) {
    return contextWindow;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
