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

/** Prefer contextTokens, then contextWindow, when present on model metadata. */
export function readAgentModelContextTokens(model: Model | null | undefined): number | undefined {
  const contextTokens = (model as AgentModelWithOptionalContextTokens | null | undefined)?.contextTokens;
  return asFiniteNumber(contextTokens) ?? asFiniteNumber(model?.contextWindow);
}
