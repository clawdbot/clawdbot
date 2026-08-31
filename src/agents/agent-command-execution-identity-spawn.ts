import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";
import type { AgentCommandOpts } from "./command/types.js";

export type AgentCommandExecutionIdentitySpawnFacts = Pick<
  ExecutionIdentityAdmissionFacts,
  "applicableGrants" | "assurance" | "ingress" | "invoker"
> & {
  spawnAdmission: string;
};

const EXECUTION_IDENTITY_SPAWN_FACTS = Symbol("executionIdentitySpawnFacts");

type AgentCommandExecutionIdentityCarrier = {
  [EXECUTION_IDENTITY_SPAWN_FACTS]?: AgentCommandExecutionIdentitySpawnFacts;
};

/** Attach authenticated spawn facts without widening the public AgentCommandOpts contract. */
export function withAgentCommandExecutionIdentitySpawnFacts<T extends AgentCommandOpts>(
  opts: T,
  facts: AgentCommandExecutionIdentitySpawnFacts | undefined,
): T {
  if (!facts) {
    return opts;
  }
  const carried = { ...opts, [EXECUTION_IDENTITY_SPAWN_FACTS]: facts };
  return carried;
}

export function readAgentCommandExecutionIdentitySpawnFacts(
  opts: AgentCommandOpts & AgentCommandExecutionIdentityCarrier,
): AgentCommandExecutionIdentitySpawnFacts | undefined {
  return opts[EXECUTION_IDENTITY_SPAWN_FACTS];
}

export function withoutAgentCommandExecutionIdentitySpawnFacts<T extends AgentCommandOpts>(
  opts: T,
): T {
  return { ...opts, [EXECUTION_IDENTITY_SPAWN_FACTS]: undefined };
}
