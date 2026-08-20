import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import { createAgentRuntimeOneShotHandoffRegistry } from "./agent-runtime-one-shot-handoff.js";
import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";

type AgentRuntimeExecutionLineage = {
  relation: "sessions_spawn";
  requesterRef: string;
  controllerRef: string;
  depth: number;
  applicableGrantRefs: string[];
  localPolicyRefs: string[];
  runtimeAssuranceRefs: string[];
  targetPolicyRefs: string[];
  externalNativeActions: "observable" | "unsupported";
};

const AGENT_RUNTIME_EXECUTION_LINEAGE = Symbol("agentRuntimeExecutionLineage");
const AGENT_RUNTIME_EXECUTION_LINEAGE_REDEMPTION = Symbol("agentRuntimeExecutionLineageRedemption");

type AgentRuntimeExecutionLineageCarrier = {
  [AGENT_RUNTIME_EXECUTION_LINEAGE]?: AgentRuntimeExecutionLineage;
};

type AgentRuntimeExecutionLineageRedemption = Readonly<{ consume: () => boolean }>;

type AgentRuntimeExecutionLineageRedemptionCarrier = {
  [AGENT_RUNTIME_EXECUTION_LINEAGE_REDEMPTION]: AgentRuntimeExecutionLineageRedemption;
};

function hasAgentRuntimeExecutionLineageRedemption(
  identity: object,
): identity is object & AgentRuntimeExecutionLineageRedemptionCarrier {
  return AGENT_RUNTIME_EXECUTION_LINEAGE_REDEMPTION in identity;
}

type ExecutionLineageHandoffPayload = Readonly<{
  executionIdentity?: ExecutionIdentityAdmissionToken;
  sessionSpawnContext: AgentRuntimeSessionSpawnContext & AgentRuntimeExecutionLineageCarrier;
}>;

const executionLineageHandoffs = createAgentRuntimeOneShotHandoffRegistry<
  ExecutionLineageHandoffPayload,
  undefined
>({
  globalKey: Symbol.for("openclaw.agentRuntimeExecutionLineageHandoffs"),
  snapshotPayload: (payload) => payload,
  sameTarget: () => true,
});

/** Add process-local lineage without expanding or serializing the spawn context. */
export function withAgentRuntimeExecutionLineage<T extends AgentRuntimeSessionSpawnContext>(
  context: T,
  lineage: AgentRuntimeExecutionLineage,
): T & AgentRuntimeExecutionLineageCarrier {
  return { ...context, [AGENT_RUNTIME_EXECUTION_LINEAGE]: lineage };
}

export function readAgentRuntimeExecutionLineage(
  context: (AgentRuntimeSessionSpawnContext & AgentRuntimeExecutionLineageCarrier) | undefined,
): AgentRuntimeExecutionLineage | undefined {
  return context?.[AGENT_RUNTIME_EXECUTION_LINEAGE];
}

/** Register a local one-shot handoff; its opaque id is correlation, never authority. */
export function createAgentRuntimeExecutionLineageHandoff(params: {
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
  executionIdentity?: ExecutionIdentityAdmissionToken;
  sessionSpawnContext: AgentRuntimeSessionSpawnContext;
}): Readonly<{ id: string; revoke: () => void }> | undefined {
  const lineage = readAgentRuntimeExecutionLineage(params.sessionSpawnContext);
  if (!lineage) {
    return undefined;
  }
  if (
    params.executionIdentity !== undefined &&
    params.executionIdentity.runId !== params.operationalRunInstance.runId
  ) {
    throw new Error("execution lineage handoff disagrees with its parent admission");
  }
  return executionLineageHandoffs.create({
    owner: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      operationalRunInstance: params.operationalRunInstance,
      delegatedAuthority: params.delegatedAuthority,
    },
    payload: Object.freeze({
      ...(params.executionIdentity ? { executionIdentity: params.executionIdentity } : {}),
      sessionSpawnContext: params.sessionSpawnContext,
    }),
    target: undefined,
  });
}

/** Redeem the host-owned handoff while binding it to the exact signed parent owner. */
export function redeemAgentRuntimeExecutionLineageHandoff(params: {
  id: string;
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
}):
  | Readonly<{
      executionIdentity?: ExecutionIdentityAdmissionToken;
      sessionSpawnContext: AgentRuntimeSessionSpawnContext;
      redemption: AgentRuntimeExecutionLineageRedemption;
    }>
  | undefined {
  const handoff = executionLineageHandoffs.redeem({
    id: params.id,
    owner: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      operationalRunInstance: params.operationalRunInstance,
      delegatedAuthority: params.delegatedAuthority,
    },
  });
  if (!handoff) {
    return undefined;
  }
  return Object.freeze({
    ...(handoff.payload.executionIdentity
      ? { executionIdentity: handoff.payload.executionIdentity }
      : {}),
    sessionSpawnContext: handoff.payload.sessionSpawnContext,
    redemption: Object.freeze({
      consume: () => handoff.consume(undefined) !== undefined,
    }),
  });
}

export function withAgentRuntimeExecutionLineageRedemption<T extends object>(
  identity: T,
  redemption: AgentRuntimeExecutionLineageRedemption,
): T & AgentRuntimeExecutionLineageRedemptionCarrier {
  return { ...identity, [AGENT_RUNTIME_EXECUTION_LINEAGE_REDEMPTION]: redemption };
}

/** Direct in-process lineage needs no redemption; handed-off lineage is one-shot. */
export function consumeAgentRuntimeExecutionLineage(identity: object): boolean {
  return hasAgentRuntimeExecutionLineageRedemption(identity)
    ? identity[AGENT_RUNTIME_EXECUTION_LINEAGE_REDEMPTION].consume()
    : true;
}
