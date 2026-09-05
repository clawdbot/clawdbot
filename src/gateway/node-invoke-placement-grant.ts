import type { ExecApprovalDecision } from "../infra/exec-approvals-core.js";
import type { NodeSession } from "./node-registry.js";
import type {
  PlacementStandingGrantMintSpec,
  PlacementStandingGrantRuntime,
} from "./operator-approval-placement-grants.js";

export type NodeInvokePlacementGrantAuthorization = {
  binding?: PlacementStandingGrantMintSpec;
};

type PlacementGrantResolution =
  | {
      kind: "granted";
      binding: PlacementStandingGrantMintSpec;
      approvalId: string;
    }
  | {
      kind: "prompt";
      binding: PlacementStandingGrantMintSpec | null;
      allowedDecisions: readonly ExecApprovalDecision[] | undefined;
    };

export type NodeInvokePlacementGrantOwner = {
  agentId: string;
  sessionKey: string;
  assertCurrent: (binding: PlacementStandingGrantMintSpec) => void;
};

function isBindingCurrentForOwner(
  owner: NodeInvokePlacementGrantOwner,
  binding: PlacementStandingGrantMintSpec,
): boolean {
  try {
    owner.assertCurrent(binding);
    return true;
  } catch {
    return false;
  }
}

export function resolveNodeInvokePlacementGrant(params: {
  runtime?: PlacementStandingGrantRuntime;
  requestedDecisions: readonly ExecApprovalDecision[] | undefined;
  owner?: NodeInvokePlacementGrantOwner;
  pluginId: string;
  command: string;
  approvalScope?: string;
  risk?: { level: "ordinary" | "high"; family: string };
  nodeSession: NodeSession;
}): PlacementGrantResolution {
  const binding =
    params.requestedDecisions?.includes("allow-always") === true &&
    params.owner &&
    params.approvalScope !== undefined &&
    params.risk?.level === "high" &&
    params.nodeSession.pairingGeneration &&
    params.runtime
      ? params.runtime.resolveBinding({
          pluginId: params.pluginId,
          command: params.command,
          approvalScope: params.approvalScope,
          agentId: params.owner.agentId,
          sessionKey: params.owner.sessionKey,
          nodeId: params.nodeSession.nodeId,
          pairingGeneration: params.nodeSession.pairingGeneration,
        })
      : null;
  const currentBinding =
    binding && params.owner && isBindingCurrentForOwner(params.owner, binding) ? binding : null;
  if (currentBinding && params.runtime) {
    const existing = params.runtime.validate(currentBinding);
    if (existing.outcome === "consumed") {
      return {
        kind: "granted",
        binding: currentBinding,
        approvalId: existing.grant.mintedByApprovalId,
      };
    }
  }
  const allowedDecisions =
    params.requestedDecisions?.includes("allow-always") === true && !currentBinding
      ? params.requestedDecisions.filter((decision) => decision !== "allow-always")
      : params.requestedDecisions;
  return { kind: "prompt", binding: currentBinding, allowedDecisions };
}

export function retainResolvedNodeInvokePlacementGrant(params: {
  runtime?: PlacementStandingGrantRuntime;
  decision: ExecApprovalDecision | null;
  binding: PlacementStandingGrantMintSpec | null;
  owner?: NodeInvokePlacementGrantOwner;
  authorization: NodeInvokePlacementGrantAuthorization;
}): boolean {
  if (params.decision !== "allow-always" || !params.binding) {
    return true;
  }
  if (
    !params.owner ||
    !isBindingCurrentForOwner(params.owner, params.binding) ||
    params.runtime?.validate(params.binding).outcome !== "consumed"
  ) {
    return false;
  }
  params.authorization.binding = params.binding;
  return true;
}

export function consumeNodeInvokePlacementGrant(params: {
  runtime?: PlacementStandingGrantRuntime;
  authorization: NodeInvokePlacementGrantAuthorization;
}): "not-required" | "consumed" | "rejected" {
  if (!params.authorization.binding) {
    return "not-required";
  }
  try {
    return params.runtime?.consume(params.authorization.binding).outcome === "consumed"
      ? "consumed"
      : "rejected";
  } catch {
    return "rejected";
  }
}
