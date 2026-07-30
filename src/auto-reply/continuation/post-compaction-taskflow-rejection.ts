import { removeUnacceptedDelegateArtifactPolicy } from "../../agents/delegate-artifacts.js";
import {
  delegateFlowRecords,
  isDurablyHandedOffPostCompactionFlow,
} from "./delegate-flow-store.js";
import { markPendingDelegateFailed } from "./delegate-store.js";

export type RejectablePostCompactionDelegate = {
  flowId?: string;
  expectedRevision?: number;
  task: string;
  returnOptions?: { artifacts?: "forbidden" | "optional" | "required" };
};

/**
 * Terminalize a post-compaction row that has already been durably handed off.
 *
 * A queued `postCompactionDelegate` entry carries the CLAIM revision, but
 * `finalizeStagedPostCompactionDelegates` moves the row to `succeeded` at
 * `claimRevision + 1` between enqueue and drain. A revision-fenced fail against
 * the stale claim revision can therefore never commit, so a delivery-time
 * rejection would throw instead of leaving a terminal row — no stale/cap/policy
 * record, a leaked artifact policy, and retry churn until the budget runs out.
 * Only this exact post-handoff shape is tolerated, mirroring
 * `revalidatePendingDelegateForSpawn`'s `isExpectedDurableHandoffRevision`;
 * anything else keeps the strict fence so a genuinely superseded claim is still
 * detected.
 */
export function failReleasedPostCompactionDelegate(
  delegate: Pick<RejectablePostCompactionDelegate, "flowId" | "expectedRevision" | "task">,
  blockedSummary: string,
  currentStep?: string,
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return markPendingDelegateFailed(delegate, blockedSummary, currentStep);
  }
  const flow = delegateFlowRecords.get(delegate.flowId);
  const durablyHandedOff = isDurablyHandedOffPostCompactionFlow(flow, delegate.expectedRevision);
  return markPendingDelegateFailed(
    durablyHandedOff && flow ? { ...delegate, expectedRevision: flow.revision } : delegate,
    blockedSummary,
    currentStep,
  );
}

export function rejectPostCompactionTaskFlowDelegate(
  delegate: RejectablePostCompactionDelegate,
  summary: string,
): boolean {
  const failed = markPendingDelegateFailed(delegate, summary, "Post-compaction delegate rejected");
  if (
    failed &&
    delegate.flowId &&
    (delegate.returnOptions?.artifacts === "optional" ||
      delegate.returnOptions?.artifacts === "required")
  ) {
    removeUnacceptedDelegateArtifactPolicy(delegate.flowId);
  }
  return failed;
}
