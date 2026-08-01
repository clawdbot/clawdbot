import type { Usage } from "../llm/types.js";
import type { CompactResult } from "./types.js";

const usageByCompactionResult = new WeakMap<CompactResult, Usage>();

/** Attaches built-in accounting data without expanding the plugin-facing result contract. */
export function attachInternalCompactionUsage<T extends CompactResult>(
  result: T,
  usage: Usage | undefined,
): T {
  if (usage) {
    usageByCompactionResult.set(result, usage);
  }
  return result;
}

export function getInternalCompactionUsage(result: CompactResult): Usage | undefined {
  return usageByCompactionResult.get(result);
}
