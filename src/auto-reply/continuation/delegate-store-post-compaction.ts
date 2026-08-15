/** Post-compaction continuation-delegate transitions over TaskFlow. */

import type { SessionPostCompactionDelegate } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  decodeDelegateFlow,
  delegateFlowRecords,
  isAwaitingNextCompactionDelegateFlow,
  isPostCompactionDelegateFlow,
  listQueuedPostCompactionFlows,
  rejectCorruptDelegateFlow,
} from "./delegate-flow-store.js";
import { scrubCancellationRequestedDelegateFlows } from "./delegate-store.js";
import type { PendingContinuationDelegate, StagedPostCompactionDelegate } from "./types.js";

/** Stage the TaskFlow-domain value used by the tool and recovery dispatcher. */
export function stagePostCompactionTaskFlowDelegate(
  sessionKey: string,
  delegate: StagedPostCompactionDelegate,
  options: { attachmentConfig?: OpenClawConfig } = {},
) {
  const pendingDelegate: PendingContinuationDelegate = {
    task: delegate.task,
    mode: "post-compaction",
    firstArmedAt: delegate.firstArmedAt ?? delegate.stagedAt,
    ...(delegate.attachments !== undefined ? { attachments: delegate.attachments } : {}),
    ...(delegate.attachAs !== undefined ? { attachAs: delegate.attachAs } : {}),
    ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
    ...(delegate.targetSessionKeys ? { targetSessionKeys: delegate.targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.returnOptions ? { returnOptions: delegate.returnOptions } : {}),
    ...(delegate.recipientContext ? { recipientContext: delegate.recipientContext } : {}),
    ...(delegate.traceparent ? { traceparent: delegate.traceparent } : {}),
    ...(delegate.model ? { model: delegate.model } : {}),
  };
  return delegateFlowRecords.create({
    ownerKey: sessionKey,
    controller: "post-compaction",
    delegate: pendingDelegate,
    currentStep: "Staged for release after compaction",
    attachmentConfig: options.attachmentConfig,
  });
}

export function requeueReleasedPostCompactionTaskFlowDelegate(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return false;
  }
  const flow = delegateFlowRecords.get(delegate.flowId);
  if (!flow || !isPostCompactionDelegateFlow(flow) || flow.status !== "running") {
    return false;
  }
  const currentDelegate = decodeDelegateFlow(flow);
  if (!currentDelegate) {
    rejectCorruptDelegateFlow(flow, { kind: "post-compaction", sessionKey: flow.ownerKey });
    return false;
  }
  const result = delegateFlowRecords.update({
    flowId: flow.flowId,
    expectedRevision: delegate.expectedRevision,
    fallbackDelegate: currentDelegate,
    changes: { releasedAt: null, awaitingNextCompaction: null },
    patch: {
      status: "queued",
      currentStep: "Staged for release after compaction",
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: Date.now(),
    },
  });
  return result.applied;
}

export function requeueAwaitingNextCompactionDelegatesRaw(options: {
  runningUpdatedAtOrBefore: number;
}): number {
  let requeued = 0;
  const flows = delegateFlowRecords.listAll();
  scrubCancellationRequestedDelegateFlows(flows);
  for (const flow of flows) {
    if (
      !isPostCompactionDelegateFlow(flow) ||
      flow.status !== "running" ||
      flow.cancelRequestedAt != null ||
      flow.updatedAt > options.runningUpdatedAtOrBefore ||
      !isAwaitingNextCompactionDelegateFlow(flow)
    ) {
      continue;
    }
    const delegate = decodeDelegateFlow(flow);
    if (delegate && requeueReleasedPostCompactionTaskFlowDelegate(delegate)) {
      requeued += 1;
    }
  }
  return requeued;
}

export function failStagedPostCompactionDelegatesForCleanup(
  sessionKey: string,
  blockedSummary: string,
): number {
  let failed = 0;
  for (const flow of delegateFlowRecords.listForOwner(sessionKey)) {
    if (
      !isPostCompactionDelegateFlow(flow) ||
      (flow.status !== "queued" && flow.status !== "running")
    ) {
      continue;
    }
    const result = delegateFlowRecords.fail({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: "Dropped post-compaction delegate during subagent cleanup",
      blockedSummary,
    });
    if (result.applied) {
      failed += 1;
    }
  }
  return failed;
}

/** Claim staged TaskFlow rows without terminalizing them before durable handoff. */
export function claimStagedPostCompactionTaskFlowDelegates(
  sessionKey: string,
  options: { claimFor?: "release" | "next-seam-persist" } = {},
): PendingContinuationDelegate[] {
  const delegates: PendingContinuationDelegate[] = [];
  scrubCancellationRequestedDelegateFlows(delegateFlowRecords.listForOwner(sessionKey));
  for (const flow of listQueuedPostCompactionFlows(sessionKey)) {
    const delegate = decodeDelegateFlow(flow);
    if (!delegate) {
      rejectCorruptDelegateFlow(flow, { kind: "post-compaction", sessionKey });
      continue;
    }
    const releasedAt = Date.now();
    const claimForNextSeamPersist = options.claimFor === "next-seam-persist";
    const claimed = delegateFlowRecords.update({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      changes: {
        releasedAt,
        ...(claimForNextSeamPersist ? { awaitingNextCompaction: true } : {}),
      },
      patch: {
        status: "running",
        currentStep: claimForNextSeamPersist
          ? "Persisting staged delegate for next compaction seam"
          : "Released after compaction — awaiting durable handoff",
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        endedAt: null,
        updatedAt: releasedAt,
      },
    });
    if (!claimed.applied) {
      continue;
    }
    const claimedDelegate = decodeDelegateFlow(claimed.flow);
    if (claimedDelegate) {
      delegates.push(claimedDelegate);
    }
  }
  return delegates;
}

export function finalizeStagedPostCompactionDelegates(
  flowIds: readonly (string | undefined)[],
): number {
  let finalized = 0;
  for (const flowId of flowIds) {
    if (!flowId) {
      continue;
    }
    const flow = delegateFlowRecords.get(flowId);
    if (!flow || !isPostCompactionDelegateFlow(flow) || flow.status !== "running") {
      continue;
    }
    const delegate = decodeDelegateFlow(flow) ?? {
      task: "",
      mode: "post-compaction" as const,
    };
    const now = Date.now();
    const finished = delegateFlowRecords.finish({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      fallbackDelegate: delegate,
      changes: { releasedAt: now },
      currentStep: "Durably handed off after compaction",
      updatedAt: now,
      endedAt: now,
    });
    if (finished.applied) {
      finalized += 1;
    }
  }
  return finalized;
}

export function assertStagedPostCompactionFinalizationComplete(params: {
  flowIds: readonly (string | undefined)[];
  finalized: number;
  context: string;
}): void {
  const expected = params.flowIds.filter(
    (flowId): flowId is string => typeof flowId === "string" && flowId.length > 0,
  ).length;
  if (params.finalized !== expected) {
    throw new Error(
      `[continuation:post-compaction-finalize-incomplete] ${params.context}: finalized ${params.finalized}/${expected} claimed row(s)`,
    );
  }
}

export function listRecoverableStagedPostCompactionDelegates(options?: {
  runningUpdatedAtOrBefore?: number;
}): Array<{ sessionKey: string; delegate: PendingContinuationDelegate }> {
  const recoverable: Array<{ sessionKey: string; delegate: PendingContinuationDelegate }> = [];
  const flows = delegateFlowRecords.listAll();
  scrubCancellationRequestedDelegateFlows(flows);
  for (const flow of flows) {
    if (
      !isPostCompactionDelegateFlow(flow) ||
      flow.status !== "running" ||
      flow.cancelRequestedAt != null
    ) {
      continue;
    }
    if (
      options?.runningUpdatedAtOrBefore !== undefined &&
      flow.updatedAt > options.runningUpdatedAtOrBefore
    ) {
      continue;
    }
    const delegate = decodeDelegateFlow(flow);
    if (!delegate) {
      // A recoverable row with invalid attachment state must not remain a
      // warning-only replay candidate: rejectCorrupt uses the terminal scrub
      // path, removing any legacy inline bytes before a later restart sees it.
      rejectCorruptDelegateFlow(flow, { kind: "post-compaction", sessionKey: flow.ownerKey });
      continue;
    }
    if (isAwaitingNextCompactionDelegateFlow(flow)) {
      continue;
    }
    recoverable.push({ sessionKey: flow.ownerKey, delegate });
  }
  return recoverable;
}

/** Stage the session-persistence value used by reply and delivery callers. */
export function stagePostCompactionDelegate(
  sessionKey: string,
  delegate: SessionPostCompactionDelegate,
): void {
  const stagedAt = delegate.createdAt ?? Date.now();
  stagePostCompactionTaskFlowDelegate(sessionKey, {
    task: delegate.task,
    stagedAt,
    firstArmedAt: delegate.firstArmedAt ?? stagedAt,
    ...(delegate.attachments !== undefined ? { attachments: delegate.attachments } : {}),
    ...(delegate.attachAs !== undefined ? { attachAs: delegate.attachAs } : {}),
    ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
    ...(delegate.targetSessionKeys ? { targetSessionKeys: delegate.targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.returnOptions ? { returnOptions: delegate.returnOptions } : {}),
    ...(delegate.recipientContext ? { recipientContext: delegate.recipientContext } : {}),
    ...(delegate.traceparent && delegate.traceparentProvenance === "internal"
      ? { traceparent: delegate.traceparent }
      : {}),
    ...(delegate.model ? { model: delegate.model } : {}),
  });
}

export function consumeStagedPostCompactionDelegates(
  sessionKey: string,
  options?: { claimFor?: "release" | "next-seam-persist" },
): SessionPostCompactionDelegate[] {
  const now = Date.now();
  const consumedDelegates: SessionPostCompactionDelegate[] = [];
  for (const claimed of claimStagedPostCompactionTaskFlowDelegates(sessionKey, options)) {
    const firstArmedAt = claimed.firstArmedAt ?? now;
    const delegate: SessionPostCompactionDelegate = {
      task: claimed.task,
      createdAt: firstArmedAt,
      firstArmedAt,
      silent: true,
      silentWake: true,
      ...(claimed.attachments ? { attachments: claimed.attachments } : {}),
      ...(claimed.attachAs ? { attachAs: claimed.attachAs } : {}),
    };
    if (claimed.targetSessionKey) {
      delegate.targetSessionKey = claimed.targetSessionKey;
    }
    if (claimed.targetSessionKeys) {
      delegate.targetSessionKeys = claimed.targetSessionKeys;
    }
    if (claimed.fanoutMode) {
      delegate.fanoutMode = claimed.fanoutMode;
    }
    if (claimed.returnOptions) {
      delegate.returnOptions = claimed.returnOptions;
    }
    if (claimed.recipientContext) {
      delegate.recipientContext = claimed.recipientContext;
    }
    if (claimed.traceparent) {
      delegate.traceparent = claimed.traceparent;
      delegate.traceparentProvenance = "internal";
    }
    if (claimed.model) {
      delegate.model = claimed.model;
    }
    if (claimed.flowId) {
      delegate.flowId = claimed.flowId;
    }
    if (claimed.expectedRevision !== undefined) {
      delegate.expectedRevision = claimed.expectedRevision;
    }
    consumedDelegates.push(delegate);
  }
  return consumedDelegates;
}

export function requeueReleasedPostCompactionDelegate(
  delegate: Pick<SessionPostCompactionDelegate, "flowId" | "expectedRevision" | "task">,
): boolean {
  return requeueReleasedPostCompactionTaskFlowDelegate(delegate);
}

export function stagedPostCompactionDelegateCount(sessionKey: string): number {
  return listQueuedPostCompactionFlows(sessionKey).length;
}
