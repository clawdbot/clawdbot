import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
// Settles run-bound approvals when their active agent run is aborted.
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";

function cancelMatchingApprovals<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  matches: (record: ExecApprovalRecord<TPayload>) => boolean;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  let cancelled = 0;
  for (const pending of params.manager.listPendingRecords()) {
    if (!params.matches(pending)) {
      continue;
    }
    const result = params.manager.forceDenyDetailed(
      pending.id,
      "run-aborted",
      { kind: "system", id: null },
      "cancelled",
    );
    if (result.outcome === "denied" && result.liveRecord) {
      cancelled += 1;
      params.publish(result.record, result.liveRecord);
    }
  }
  return cancelled;
}

export function cancelAgentRuntimeBoundApprovals<TPayload>(params: {
  authority: AgentRunDelegatedAuthority;
  manager: ExecApprovalManager<TPayload>;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  return cancelMatchingApprovals({
    manager: params.manager,
    publish: params.publish,
    matches: (pending) => {
      const bound = pending.agentRuntimeDelegatedAuthority;
      return (
        bound?.claimId === params.authority.claimId &&
        bound.lifecycleGeneration === params.authority.lifecycleGeneration &&
        bound.operationalRunInstance.instanceId ===
          params.authority.operationalRunInstance.instanceId &&
        bound.operationalRunInstance.runId === params.authority.operationalRunInstance.runId
      );
    },
  });
}

function sameWorkerTurnClaim(left: WorkerSessionTurnClaim, right: WorkerSessionTurnClaim): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.claimId === right.claimId &&
    left.runId === right.runId &&
    left.placementGeneration === right.placementGeneration &&
    left.owner.kind === "worker" &&
    right.owner.kind === "worker" &&
    left.owner.environmentId === right.owner.environmentId &&
    left.owner.ownerEpoch === right.owner.ownerEpoch
  );
}

/** Settles approvals whose authoritative worker turn claim has been fenced. */
export function cancelWorkerTurnClaimBoundApprovals<TPayload>(params: {
  claim: WorkerSessionTurnClaim;
  manager: ExecApprovalManager<TPayload>;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  return cancelMatchingApprovals({
    manager: params.manager,
    publish: params.publish,
    matches: (pending) => {
      const authority = pending.agentRuntimeDelegatedAuthority;
      return authority?.kind === "worker" && sameWorkerTurnClaim(authority.turnClaim, params.claim);
    },
  });
}

/** Preserves legacy run-id abort cleanup only for records without delegated authority. */
export function cancelUnboundRunApprovals<TPayload extends { runId?: string | null }>(params: {
  runId: string;
  manager: ExecApprovalManager<TPayload>;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  return cancelMatchingApprovals({
    manager: params.manager,
    publish: params.publish,
    matches: (pending) =>
      !pending.agentRuntimeDelegatedAuthority && pending.request.runId === params.runId,
  });
}
