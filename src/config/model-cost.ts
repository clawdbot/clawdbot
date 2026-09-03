import type { ModelDefinitionConfig } from "./types.models.js";

/** Merge rates without letting inherited tiers silently replace authored flat or zero pricing. */
export function mergeModelCost(
  lowerPriority: ModelDefinitionConfig["cost"] | undefined,
  higherPriority: ModelDefinitionConfig["cost"] | undefined,
): ModelDefinitionConfig["cost"] | undefined {
  if (!lowerPriority || !higherPriority) {
    return higherPriority ?? lowerPriority;
  }
  if (Object.keys(higherPriority).length === 0) {
    return lowerPriority;
  }
  const { tieredPricing: _tieredPricing, ...lowerPriorityRates } = lowerPriority;
  return { ...lowerPriorityRates, ...higherPriority };
}
