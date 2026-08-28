import type { ExecutionIdentityAdmissionFacts } from "../../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../../audit/execution-identity-spawn-admission.js";
import {
  consumeAgentRuntimeExecutionLineage,
  readAgentRuntimeExecutionLineage,
} from "../agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";

type ExecutionIdentitySpawnFacts = Pick<
  ExecutionIdentityAdmissionFacts,
  "applicableGrants" | "assurance" | "ingress" | "invoker"
> & {
  spawnAdmission: string;
};

/** Consume authenticated spawn provenance once, at the child admission owner. */
export function resolveExecutionIdentitySpawnFacts(
  identity: AgentRuntimeIdentity | undefined,
): ExecutionIdentitySpawnFacts | undefined {
  const lineage = readAgentRuntimeExecutionLineage(identity?.sessionSpawnContext);
  if (!identity || !lineage || !consumeAgentRuntimeExecutionLineage(identity)) {
    return undefined;
  }
  const parent = identity.executionIdentity;
  return {
    ingress: {
      kind: lineage.externalNativeActions === "unsupported" ? "acp" : "subagent",
      boundary: `sessions_spawn.${lineage.externalNativeActions === "unsupported" ? "acp" : "subagent"}`,
      state: "present",
    },
    invoker: { state: "present", kind: "agent", rawPrincipalRef: identity.agentId },
    applicableGrants: lineage.applicableGrantRefs.map((rawGrantRef) => ({
      rawGrantRef,
      state: "present",
    })),
    assurance: [
      {
        kind: "spawn-lineage",
        rawEvidenceRef: lineage.requesterRef,
        strength: "boundary-verified",
      },
      ...lineage.runtimeAssuranceRefs.map((rawEvidenceRef) => ({
        kind: "runtime-binding" as const,
        rawEvidenceRef,
        strength: "boundary-verified" as const,
      })),
    ],
    spawnAdmission: executionIdentitySpawnAdmission({
      operation: "serialize",
      value: {
        ...(parent?.contextId ? { parentContextId: parent.contextId } : {}),
        ...(parent?.executionId ? { parentExecutionId: parent.executionId } : {}),
        ...(parent?.runId ? { parentRunId: parent.runId } : {}),
        parentAgentId: identity.agentId,
        relation: lineage.relation,
        rawRequesterRef: lineage.requesterRef,
        rawControllerRef: lineage.controllerRef,
        depth: lineage.depth,
        localPolicyRefs: lineage.localPolicyRefs,
        targetPolicyRefs: lineage.targetPolicyRefs,
      },
      extra: [
        ...(!parent?.contextId ? ["lineage.parent-context"] : []),
        ...(!parent?.executionId ? ["lineage.parent-execution"] : []),
        ...(!parent?.runId ? ["lineage.parent-run"] : []),
        ...(lineage.externalNativeActions === "unsupported" ? ["acp.native-action-callback"] : []),
      ],
    }),
  };
}
