import type {
  ClawLifecyclePlanResult,
  ClawStatusEntry,
} from "../../../../packages/gateway-protocol/src/index.js";

type ClawCatalogCoordinate = { packageName: string; version: string };

export type PendingClawOperation =
  | { operation: "add"; source: ClawCatalogCoordinate; agentId?: string }
  | { operation: "update"; target: string; source?: ClawCatalogCoordinate }
  | { operation: "remove"; target: string };

export function catalogUpdateTargets<T extends Pick<ClawStatusEntry, "agentId" | "name">>(
  records: readonly T[],
  packageName: string,
  selectedAgentId: string | null,
  selectedAgentExplicit: boolean,
): T[] {
  const matches = records.filter((record) => record.name === packageName);
  const selected = selectedAgentExplicit
    ? matches.find((record) => record.agentId === selectedAgentId)
    : undefined;
  return selected ? [selected] : matches;
}

export function buildClawApplyRequest(params: {
  pending: PendingClawOperation;
  plan: ClawLifecyclePlanResult;
  removeUnused: boolean;
  riskAcknowledged: boolean;
}): { method: string; request: Record<string, unknown> } | null {
  const { pending, plan } = params;
  if (pending.operation !== plan.operation || plan.blockers.length > 0) {
    return null;
  }
  if (plan.riskAcknowledgementRequired && !params.riskAcknowledged) {
    return null;
  }
  const consent = params.riskAcknowledged ? { acknowledgeClawHubRisk: true } : {};
  if (pending.operation === "add") {
    return {
      method: "claws.add.apply",
      request: {
        source: pending.source,
        ...(pending.agentId ? { agentId: pending.agentId } : {}),
        planIntegrity: plan.planIntegrity,
        ...consent,
      },
    };
  }
  if (pending.operation === "update") {
    return {
      method: "claws.update.apply",
      request: {
        target: pending.target,
        ...(pending.source ? { source: pending.source } : {}),
        planIntegrity: plan.planIntegrity,
        ...consent,
      },
    };
  }
  return {
    method: "claws.remove.apply",
    request: {
      target: pending.target,
      removeUnused: params.removeUnused,
      planIntegrity: plan.planIntegrity,
    },
  };
}
