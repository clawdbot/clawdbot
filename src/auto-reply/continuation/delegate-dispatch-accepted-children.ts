import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
  isSubagentRunLive,
} from "../../agents/subagent-registry-read.js";

export function partitionKnownAcceptedDelegateChildren<T extends { flowId?: string }>(params: {
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
    const accepted =
      isSubagentRunLive(getSubagentRunByChildSessionKey(childSessionKey)) ||
      hasLiveContinuationDelegateChildRun({ childSessionKey, flowId: delegate.flowId });
    if (accepted) {
      acceptedDelegates.push(delegate);
      acceptedChildSessionKeysByFlowId.set(delegate.flowId, childSessionKey);
    } else {
      pendingDelegates.push(delegate);
    }
  }
  return { acceptedDelegates, pendingDelegates, acceptedChildSessionKeysByFlowId };
}
