import type { Usage } from "@openclaw/llm-core";

const usageByResult = new WeakMap<object, Usage>();

/** Keeps provider usage available to OpenClaw core without changing public result contracts. */
export function attachInternalAgentCoreUsage<T extends object>(
  result: T,
  usage: Usage | undefined,
): T {
  if (usage) {
    usageByResult.set(result, usage);
  }
  return result;
}

export function getInternalAgentCoreUsage(result: object): Usage | undefined {
  return usageByResult.get(result);
}
