import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";

const inProcessAgentRuntimeIdentities = new WeakMap<object, AgentRuntimeIdentity>();

/** Carry authenticated runtime identity without widening plugin dispatch options. */
export function withInProcessAgentRuntimeIdentity<T extends object>(
  options: T,
  identity: AgentRuntimeIdentity | undefined,
): T {
  if (!identity) {
    return options;
  }
  const carried = { ...options };
  inProcessAgentRuntimeIdentities.set(carried, identity);
  return carried;
}

export function readInProcessAgentRuntimeIdentity(
  options: object | undefined,
): AgentRuntimeIdentity | undefined {
  return options ? inProcessAgentRuntimeIdentities.get(options) : undefined;
}
