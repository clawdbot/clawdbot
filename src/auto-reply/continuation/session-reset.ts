import {
  isContinuationDelegateFlow,
  scrubStoredDelegateAttachmentState,
} from "../../tasks/task-flow-continuation-state.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  listTaskFlowsForOwnerKey,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-runtime-internal.js";
import { isContinuationWorkFlow } from "./work-flow-state.js";

export class SessionContinuationResetError extends Error {
  constructor(flowId: string, reason: string) {
    super(`Session reset could not cancel continuation flow ${flowId}: ${reason}. Retry.`);
    this.name = "SessionContinuationResetError";
  }
}

function isResettableContinuationFlow(flow: TaskFlowRecord): boolean {
  return (
    (isContinuationWorkFlow(flow) || isContinuationDelegateFlow(flow)) &&
    (flow.status === "queued" || flow.status === "running")
  );
}

/** Terminalize durable continuation work owned by one reset session. */
export function cancelSessionContinuations(sessionKey: string): void {
  const flows = listTaskFlowsForOwnerKey(sessionKey).filter(isResettableContinuationFlow);
  const endedAt = Date.now();
  for (const flow of flows) {
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "cancelled",
        currentStep: "Cancelled by session reset",
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        cancelRequestedAt: endedAt,
        endedAt,
        updatedAt: endedAt,
        ...(isContinuationDelegateFlow(flow)
          ? { stateJson: scrubStoredDelegateAttachmentState(flow.stateJson) }
          : {}),
      },
    });
    if (!result.applied) {
      throw new SessionContinuationResetError(flow.flowId, result.reason);
    }
  }
}
