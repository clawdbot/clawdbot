import type { Model } from "../../llm/types.js";

/**
 * Reads optional context-token metadata from discovered models without widening the core model type.
 */
type AgentModelWithOptionalContextTokens = Model & {
  contextTokens?: number;
};

/** Returns finite context-token metadata when a model discovery source provided it. */
export function readAgentModelContextTokens(model: Model | null | undefined): number | undefined {
  const value = (model as AgentModelWithOptionalContextTokens | null | undefined)?.contextTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
