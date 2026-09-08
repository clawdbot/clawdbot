import type { ToolStreamHost } from "./tool-stream-contract.ts";

export function syncToolStreamMessages(host: ToolStreamHost) {
  host.chatToolMessages = host.toolStreamOrder
    .map((id) => host.toolStreamById.get(id)?.message)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg));
}

export function cancelToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
}

export function resetToolStream(host: ToolStreamHost) {
  cancelToolStreamSync(host);
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.activityEventSeqById?.clear();
  host.chatToolMessages = [];
  host.chatStreamSegments = [];
  host.knownAgentRunIds?.clear();
  host.waitingApprovalStatuses?.clear();
  // Resolution can beat the overlay queue update. Keep tombstones across transient stream resets
  // until snapshot reconciliation observes the approval leaving the queue.
}

export function resetToolStreamRun(host: ToolStreamHost, runId: string) {
  cancelToolStreamSync(host);
  const removedIdentities = new Set<string>();
  for (const identity of host.toolStreamOrder) {
    const entry = host.toolStreamById.get(identity);
    if (entry?.runId !== runId) {
      continue;
    }
    removedIdentities.add(identity);
  }
  for (const identity of removedIdentities) {
    host.toolStreamById.delete(identity);
  }
  const activityPrefix = `tool:[${JSON.stringify(runId)},`;
  for (const sequenceIdentity of host.activityEventSeqById?.keys() ?? []) {
    if (sequenceIdentity.startsWith(activityPrefix)) {
      host.activityEventSeqById?.delete(sequenceIdentity);
    }
  }
  host.toolStreamOrder = host.toolStreamOrder.filter(
    (identity) => !removedIdentities.has(identity),
  );
  syncToolStreamMessages(host);
  host.chatStreamSegments = host.chatStreamSegments.filter((segment) => segment.runId !== runId);
  host.knownAgentRunIds?.delete(runId);
  for (const [approvalId, waitingApproval] of host.waitingApprovalStatuses ?? []) {
    if (waitingApproval.runId === runId) {
      host.waitingApprovalStatuses?.delete(approvalId);
    }
  }
}
