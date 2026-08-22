/** Per-agent model routing policy primitives. */
import type { ModelRoutingPolicy, ModelTask } from "./smart-model-router.js";

export type AgentModelPolicy = {
  mode?: ModelRoutingPolicy;
  preferredModels?: string[];
  blockedModels?: string[];
  requiredCapabilities?: ModelTask[];
  maxFallbackAttempts?: number;
  allowPaidFallback?: boolean;
};

export type AgentModelPolicyConfig = Record<string, AgentModelPolicy | undefined>;

export function resolveAgentModelPolicy(params: {
  agentId: string;
  policies?: AgentModelPolicyConfig;
  defaults?: AgentModelPolicy;
}): AgentModelPolicy {
  const defaults = params.defaults ?? { mode: "free-first" };
  const configured = params.policies?.[params.agentId];
  return {
    ...defaults,
    ...configured,
    preferredModels: configured?.preferredModels ?? defaults.preferredModels,
    blockedModels: configured?.blockedModels ?? defaults.blockedModels,
    requiredCapabilities: configured?.requiredCapabilities ?? defaults.requiredCapabilities,
    maxFallbackAttempts: configured?.maxFallbackAttempts ?? defaults.maxFallbackAttempts ?? 3,
    allowPaidFallback: configured?.allowPaidFallback ?? defaults.allowPaidFallback ?? false,
  };
}
