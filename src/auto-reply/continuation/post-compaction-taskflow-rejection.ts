import { removeUnacceptedDelegateArtifactPolicy } from "../../agents/delegate-artifacts.js";
import { markPendingDelegateFailed } from "./delegate-store.js";

export type RejectablePostCompactionDelegate = {
  flowId?: string;
  expectedRevision?: number;
  task: string;
  returnOptions?: { artifacts?: "forbidden" | "optional" | "required" };
};

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
