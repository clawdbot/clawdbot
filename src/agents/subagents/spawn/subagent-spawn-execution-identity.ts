import { createHash } from "node:crypto";
import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { withAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeSessionSpawnContext } from "../../../gateway/agent-runtime-identity-token.js";

type SubagentGatewayExecutionIdentity = {
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
  parentExecutionIdentityToken?: ExecutionIdentityAdmissionToken;
};

const subagentGatewayExecutionIdentities = new WeakMap<object, SubagentGatewayExecutionIdentity>();

function spawnInputRef(kind: string, value: unknown): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}

export function buildSubagentExecutionSessionSpawnContext(params: {
  enabled: boolean;
  backend: "acp" | "subagent";
  parentAgentId: string;
  requesterRef: string;
  controllerRef: string;
  depth: number;
  maxDepth?: number;
  targetAgentId: string;
  sandbox: "inherit" | "require";
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
}): AgentRuntimeSessionSpawnContext | undefined {
  if (!params.enabled) {
    return undefined;
  }
  const allow = params.inheritedToolAllowlist ?? [];
  const deny = params.inheritedToolDenylist ?? [];
  return withAgentRuntimeExecutionLineage(
    {
      inheritedToolPolicy: { version: 1, allow, deny },
    },
    {
      relation: "sessions_spawn",
      requesterRef: params.requesterRef,
      controllerRef: params.controllerRef,
      depth: params.depth,
      applicableGrantRefs: ["tool:sessions_spawn"],
      localPolicyRefs: [
        spawnInputRef("spawn-depth-policy", [params.depth, params.maxDepth]),
        spawnInputRef("sandbox-policy", [params.backend, params.sandbox]),
        spawnInputRef("inherited-tool-policy", {
          allow: allow.toSorted(),
          deny: deny.toSorted(),
        }),
      ],
      runtimeAssuranceRefs: [`spawn-runtime:${params.backend}`],
      targetPolicyRefs: [
        spawnInputRef("target-policy", [params.parentAgentId, params.targetAgentId]),
      ],
      externalNativeActions: params.backend === "acp" ? "unsupported" : "observable",
    },
  );
}

export function withSubagentGatewayExecutionIdentity<T extends object>(
  params: T,
  facts: SubagentGatewayExecutionIdentity,
): T {
  const carried = { ...params };
  subagentGatewayExecutionIdentities.set(carried, facts);
  return carried;
}

export function readSubagentGatewayExecutionIdentity(
  params: object,
): SubagentGatewayExecutionIdentity | undefined {
  return subagentGatewayExecutionIdentities.get(params);
}
