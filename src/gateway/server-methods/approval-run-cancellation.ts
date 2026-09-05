import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
// Settles run-bound approvals when a run stops or its tool permissions change.
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.js";
import {
  sameWorkerSessionTurnClaim,
  type WorkerSessionTurnClaim,
} from "../worker-environments/placement-record.js";

type ApprovalCancellationManager<TPayload> = Pick<
  ExecApprovalManager<TPayload>,
  "listPendingRecords" | "forceDenyDetailed"
>;

function cancelMatchingApprovals<TPayload>(params: {
  reason?: "run-aborted" | "permission-change" | "approval-scope-closed";
  manager: ApprovalCancellationManager<TPayload>;
  matches: (record: ExecApprovalRecord<TPayload>) => boolean;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  let cancelled = 0;
  for (const pending of params.manager.listPendingRecords()) {
    if (!params.matches(pending)) {
      continue;
    }
    // Revoke the issuing execution, not necessarily the outer agent loop.
    // Keep the shipped cancellation reason; record the specific system resolver.
    const resolverId = params.reason && params.reason !== "run-aborted" ? params.reason : null;
    const result = params.manager.forceDenyDetailed(
      pending.id,
      "run-aborted",
      { kind: "system", id: resolverId },
      "cancelled",
      undefined,
      false,
      resolverId,
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
  reason?: "run-aborted" | "permission-change" | "approval-scope-closed";
  manager: ApprovalCancellationManager<TPayload>;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  return cancelMatchingApprovals({
    reason: params.reason,
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

/** Settles approvals whose authoritative worker turn claim has been fenced. */
export function cancelWorkerTurnClaimBoundApprovals<TPayload>(params: {
  claim: WorkerSessionTurnClaim;
  manager: ApprovalCancellationManager<TPayload>;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  return cancelMatchingApprovals({
    manager: params.manager,
    publish: params.publish,
    matches: (pending) => {
      const authority = pending.agentRuntimeDelegatedAuthority;
      return (
        authority?.kind === "worker" &&
        params.claim.owner.kind === "worker" &&
        sameWorkerSessionTurnClaim(authority.turnClaim, params.claim)
      );
    },
  });
}

/** Preserves legacy run-id abort cleanup only for records without delegated authority. */
export function cancelUnboundRunApprovals<TPayload extends { runId?: string | null }>(params: {
  runId: string;
  manager: ApprovalCancellationManager<TPayload>;
  publish: (record: OperatorApprovalRecord, liveRecord: ExecApprovalRecord<TPayload>) => void;
}): number {
  return cancelMatchingApprovals({
    manager: params.manager,
    publish: params.publish,
    matches: (pending) =>
      !pending.agentRuntimeDelegatedAuthority && pending.request.runId === params.runId,
  });
}
