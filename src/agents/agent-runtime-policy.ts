import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";

type AgentRuntimePolicyContainer = {
  agentRuntime?: AgentRuntimePolicyConfig;
};

export function resolveAgentRuntimePolicy(
  container: AgentRuntimePolicyContainer | undefined,
): AgentRuntimePolicyConfig | undefined {
  const preferred = container?.agentRuntime;
  if (hasAgentRuntimePolicy(preferred)) {
    return preferred;
  }
  return undefined;
}

function hasAgentRuntimePolicy(value: AgentRuntimePolicyConfig | undefined): boolean {
  return Boolean(value?.id?.trim());
}
