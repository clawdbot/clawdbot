import type { MemoryFlushAppendBudget } from "../../memory-flush-append.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const memoryFlushAppendBudgets = new WeakMap<object, MemoryFlushAppendBudget>();

export function attachMemoryFlushAppendBudget<T extends RunEmbeddedAgentParams>(
  params: T,
  budget: MemoryFlushAppendBudget,
): T {
  memoryFlushAppendBudgets.set(params, budget);
  return params;
}

export function getAttachedMemoryFlushAppendBudget(
  params: RunEmbeddedAgentParams,
): MemoryFlushAppendBudget | undefined {
  return memoryFlushAppendBudgets.get(params);
}

export function copyAttachedMemoryFlushAppendBudget<
  T extends RunEmbeddedAgentParams,
  U extends RunEmbeddedAgentParams,
>(source: T, target: U): U {
  const budget = getAttachedMemoryFlushAppendBudget(source);
  if (budget) {
    attachMemoryFlushAppendBudget(target, budget);
  }
  return target;
}
