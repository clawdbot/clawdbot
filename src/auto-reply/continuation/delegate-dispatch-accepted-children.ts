import { hasRecordedDelegateArtifactCompletionForProducer } from "../../agents/delegate-artifacts.js";
import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
  isSubagentRunLive,
} from "../../agents/subagents/registry/subagent-registry-read.js";

export function partitionKnownAcceptedDelegateChildren<
  T extends {
    flowId?: string;
    returnOptions?: { artifacts?: "forbidden" | "optional" | "required" };
  },
>(params: {
  delegates: T[];
  parentSessionKey: (delegate: T) => string;
}): {
  acceptedDelegates: T[];
  pendingDelegates: T[];
  acceptedChildSessionKeysByFlowId: Map<string, string>;
} {
  const acceptedDelegates: T[] = [];
  const pendingDelegates: T[] = [];
  const acceptedChildSessionKeysByFlowId = new Map<string, string>();
  for (const delegate of params.delegates) {
    if (!delegate.flowId) {
      pendingDelegates.push(delegate);
      continue;
    }
    const childSessionKey = deriveContinuationDelegateChildSessionKeyFromParent(
      params.parentSessionKey(delegate),
      delegate.flowId,
    );
    const managedArtifacts =
      delegate.returnOptions?.artifacts === "optional" ||
      delegate.returnOptions?.artifacts === "required";
    const accepted =
      isSubagentRunLive(getSubagentRunByChildSessionKey(childSessionKey)) ||
      hasLiveContinuationDelegateChildRun({ childSessionKey, flowId: delegate.flowId }) ||
      // The registry only knows live runs, so an accepted child that finished
      // before its acceptance commit was re-driven (or before a restart) would
      // otherwise be re-spawned or reported as a spawn failure. A recorded
      // completion bound to this exact producer is the durable proof it ran.
      (managedArtifacts &&
        hasRecordedDelegateArtifactCompletionForProducer({
          flowId: delegate.flowId,
          producerSessionKey: childSessionKey,
        }));
    if (accepted) {
      acceptedDelegates.push(delegate);
      acceptedChildSessionKeysByFlowId.set(delegate.flowId, childSessionKey);
    } else {
      pendingDelegates.push(delegate);
    }
  }
  return { acceptedDelegates, pendingDelegates, acceptedChildSessionKeysByFlowId };
}
