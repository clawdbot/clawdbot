import { resolveOpenRouterThinkingProfile } from "./thinking-policy.js";

export function resolveThinkingProfile(params: { provider?: string; modelId: string }) {
  return resolveOpenRouterThinkingProfile(params.modelId);
}
