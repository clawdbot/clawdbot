import type { AgentCommandExecutionIdentitySpawnFacts } from "../../agents/agent-command-execution-identity-spawn.js";

const dispatchExecutionIdentities = new WeakMap<object, AgentCommandExecutionIdentitySpawnFacts>();

export function withAgentRunDispatchExecutionIdentity<T extends object>(
  params: T,
  facts: AgentCommandExecutionIdentitySpawnFacts | undefined,
): T {
  if (!facts) {
    return params;
  }
  const carried = { ...params };
  dispatchExecutionIdentities.set(carried, facts);
  return carried;
}

export function readAgentRunDispatchExecutionIdentity(
  params: object,
): AgentCommandExecutionIdentitySpawnFacts | undefined {
  return dispatchExecutionIdentities.get(params);
}
