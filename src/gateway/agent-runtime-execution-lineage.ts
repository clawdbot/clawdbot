import { randomUUID } from "node:crypto";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
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

const EXECUTION_LINEAGE_HANDOFF_TTL_MS = 60_000;
const MAX_EXECUTION_LINEAGE_HANDOFFS = 256;

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

type ExecutionLineageHandoff = Readonly<{
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
  executionIdentity?: ExecutionIdentityAdmissionToken;
  sessionSpawnContext: AgentRuntimeSessionSpawnContext & AgentRuntimeExecutionLineageCarrier;
  expiresAtMs: number;
}>;

const executionLineageHandoffs = resolveGlobalMap<string, ExecutionLineageHandoff>(
  Symbol.for("openclaw.agentRuntimeExecutionLineageHandoffs"),
  (handoffs) => handoffs.clear(),
);

function sameOperationalRunInstance(
  left: Readonly<{ instanceId: string; runId: string }>,
  right: Readonly<{ instanceId: string; runId: string }>,
): boolean {
  return left.instanceId === right.instanceId && left.runId === right.runId;
}

function pruneExecutionLineageHandoffs(nowMs: number): void {
  for (const [id, handoff] of executionLineageHandoffs) {
    if (
      handoff.expiresAtMs <= nowMs ||
      !validateAgentRunDelegatedAuthority(handoff.delegatedAuthority)
    ) {
      executionLineageHandoffs.delete(id);
    }
  }
  // A lost local connection must not leave an unbounded process-lifetime registry.
  // Oldest insertion wins because Map preserves insertion order.
  while (executionLineageHandoffs.size >= MAX_EXECUTION_LINEAGE_HANDOFFS) {
    const oldest = executionLineageHandoffs.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    executionLineageHandoffs.delete(oldest);
  }
}

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
  if (!lineage || !validateAgentRunDelegatedAuthority(params.delegatedAuthority)) {
    return undefined;
  }
  if (
    !sameOperationalRunInstance(
      params.operationalRunInstance,
      params.delegatedAuthority.operationalRunInstance,
    ) ||
    (params.executionIdentity !== undefined &&
      params.executionIdentity.runId !== params.operationalRunInstance.runId)
  ) {
    throw new Error("execution lineage handoff disagrees with its parent admission");
  }
  const nowMs = Date.now();
  pruneExecutionLineageHandoffs(nowMs);
  const id = randomUUID();
  executionLineageHandoffs.set(
    id,
    Object.freeze({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      operationalRunInstance: params.operationalRunInstance,
      delegatedAuthority: params.delegatedAuthority,
      ...(params.executionIdentity ? { executionIdentity: params.executionIdentity } : {}),
      sessionSpawnContext: params.sessionSpawnContext,
      expiresAtMs: nowMs + EXECUTION_LINEAGE_HANDOFF_TTL_MS,
    }),
  );
  return Object.freeze({
    id,
    revoke: () => {
      executionLineageHandoffs.delete(id);
    },
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
  const handoff = executionLineageHandoffs.get(params.id);
  executionLineageHandoffs.delete(params.id);
  if (
    !handoff ||
    handoff.expiresAtMs <= Date.now() ||
    handoff.agentId !== params.agentId ||
    handoff.sessionKey !== params.sessionKey ||
    !sameOperationalRunInstance(handoff.operationalRunInstance, params.operationalRunInstance) ||
    handoff.delegatedAuthority.claimId !== params.delegatedAuthority.claimId ||
    handoff.delegatedAuthority.lifecycleGeneration !==
      params.delegatedAuthority.lifecycleGeneration ||
    !validateAgentRunDelegatedAuthority(handoff.delegatedAuthority)
  ) {
    return undefined;
  }
  let consumed = false;
  return Object.freeze({
    ...(handoff.executionIdentity ? { executionIdentity: handoff.executionIdentity } : {}),
    sessionSpawnContext: handoff.sessionSpawnContext,
    redemption: Object.freeze({
      consume: () => {
        if (consumed || !validateAgentRunDelegatedAuthority(handoff.delegatedAuthority)) {
          return false;
        }
        consumed = true;
        return true;
      },
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
