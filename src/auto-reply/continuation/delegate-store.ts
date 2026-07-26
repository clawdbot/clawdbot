/** Canonical continuation-delegate business transitions over TaskFlow. */

import type { SessionPostCompactionDelegate } from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  decodeDelegateFlow,
  delegateDueAt,
  delegateFlowRecords,
  isAwaitingNextCompactionDelegateFlow,
  isPendingDelegateFlow,
  isPostCompactionDelegateFlow,
  isRecoverableContinuationDelegateFlow,
  isRecoverablePendingFlow,
  isRecoverablePendingFlowWithinCutoffs,
  isSucceededDelegateFlow,
  listQueuedPendingFlows,
  listQueuedPostCompactionFlows,
  listRecoverablePendingFlows,
  rejectCorruptDelegateFlow,
  resetDelegateFlowDiagnosticsForTests,
  type PendingDelegateCutoffOptions,
} from "./delegate-flow-store.js";
import type {
  ChainState,
  PendingContinuationDelegate,
  StagedPostCompactionDelegate,
} from "./types.js";

const log = createSubsystemLogger("continuation/delegate-store");
type DelegateFlowRecord = ReturnType<typeof delegateFlowRecords.listAll>[number];

/** Enqueue a delegate from the `continue_delegate` tool. */
export function enqueuePendingDelegate(sessionKey: string, delegate: PendingContinuationDelegate) {
  const isPostCompaction = delegate.mode === "post-compaction";
  return delegateFlowRecords.create({
    ownerKey: sessionKey,
    controller: isPostCompaction ? "post-compaction" : "pending",
    delegate,
    currentStep: isPostCompaction
      ? "Staged for release after compaction"
      : "Queued for continuation dispatch",
  });
}

export function listPendingDelegateSessionKeysForRecovery(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning"> = {},
): string[] {
  const sessionKeys = delegateFlowRecords
    .listAll()
    .filter((flow) =>
      isRecoverablePendingFlowWithinCutoffs(flow, {
        includeRunning: true,
        queuedCreatedAtOrBefore: options.queuedCreatedAtOrBefore,
        includeRunningUpdatedAtOrBefore: options.includeRunningUpdatedAtOrBefore,
      }),
    )
    .map((flow) => flow.ownerKey);
  return [...new Set(sessionKeys)].toSorted();
}

/** Decode cutoff-eligible recovery rows solely to terminalize malformed state. */
export function classifyRecoverablePendingDelegates(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning"> = {},
): void {
  for (const flow of delegateFlowRecords.listAll()) {
    if (
      !isRecoverablePendingFlowWithinCutoffs(flow, {
        includeRunning: true,
        queuedCreatedAtOrBefore: options.queuedCreatedAtOrBefore,
        includeRunningUpdatedAtOrBefore: options.includeRunningUpdatedAtOrBefore,
      })
    ) {
      continue;
    }
    if (!decodeDelegateFlow(flow)) {
      rejectCorruptDelegateFlow(flow, { kind: "pending", sessionKey: flow.ownerKey });
    }
  }
}

/**
 * Claim matured delegates in FIFO order. Queued rows retain their original
 * delay horizon; already-running recovery rows are never delay-gated.
 */
export function consumePendingDelegates(
  sessionKey: string,
  options: PendingDelegateCutoffOptions & { ignoreDelay?: boolean } = {},
): PendingContinuationDelegate[] {
  const delegates: PendingContinuationDelegate[] = [];
  const now = Date.now();

  for (const flow of listRecoverablePendingFlows(sessionKey, options)) {
    const delegate = decodeDelegateFlow(flow);
    if (!delegate) {
      rejectCorruptDelegateFlow(flow, { kind: "pending", sessionKey });
      continue;
    }
    if (!options.ignoreDelay && flow.status === "queued" && now < delegateDueAt(flow, delegate)) {
      continue;
    }

    const releasedAt = Date.now();
    const claimed = delegateFlowRecords.update({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      changes: { releasedAt },
      patch: {
        status: "running",
        currentStep:
          flow.status === "running"
            ? "Re-driving continuation delegate spawn"
            : "Released to continuation scheduler",
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

export function markPendingDelegateSpawnAccepted(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  childSessionKey: string,
  options: { requireWriteSuccess?: boolean } = {},
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-accept-missing-flow] cannot commit accepted delegate because flow metadata is missing",
    );
    return false;
  }
  const current = delegateFlowRecords.get(delegate.flowId);
  const currentDelegate = (current && decodeDelegateFlow(current)) ?? { task: delegate.task };
  const now = Date.now();
  const expectedRevision = delegate.expectedRevision;
  const finished = delegateFlowRecords.finish({
    flowId: delegate.flowId,
    expectedRevision,
    fallbackDelegate: currentDelegate,
    changes: { childSessionKey },
    currentStep: "Accepted by continuation subagent",
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    if (finished.current && isSucceededDelegateFlow(finished.current)) {
      return true;
    }
    const message = `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${expectedRevision} acceptance was not committed`;
    log.warn(message);
    if (options.requireWriteSuccess === true) {
      throw new Error(message);
    }
  }
  return finished.applied;
}

export function markPendingDelegateFailed(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  blockedSummary: string,
  currentStep = "Delegate spawn failed",
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-fail-missing-flow] cannot mark consumed delegate failed because flow metadata is missing",
    );
    return false;
  }

  const failed = delegateFlowRecords.fail({
    flowId: delegate.flowId,
    expectedRevision: delegate.expectedRevision,
    currentStep,
    blockedSummary,
    updatedAt: Date.now(),
  });
  if (failed.applied) {
    return true;
  }
  return failed.current?.status === "failed";
}

export function requeuePendingDelegate(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  currentStep = "Deferred until continuation is re-enabled",
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return false;
  }
  const current = delegateFlowRecords.get(delegate.flowId);
  const currentDelegate = (current && decodeDelegateFlow(current)) ?? { task: delegate.task };
  const requeued = delegateFlowRecords.update({
    flowId: delegate.flowId,
    expectedRevision: delegate.expectedRevision,
    fallbackDelegate: currentDelegate,
    changes: { releasedAt: null },
    patch: {
      status: "queued",
      currentStep,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: Date.now(),
    },
  });
  return requeued.applied;
}

export function markPendingDelegateChainStatePersistPlanned(
  delegate: Pick<
    PendingContinuationDelegate,
    "flowId" | "expectedRevision" | "task" | "persistedChainState" | "persistedChainStateKind"
  >,
  chainState: ChainState,
  kind: "advanced" | "terminal" = "advanced",
): PendingContinuationDelegate {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-chain-state-plan-missing-flow] cannot mark planned chain state because flow metadata is missing",
    );
    return {
      task: delegate.task,
      ...(delegate.persistedChainState
        ? { persistedChainState: delegate.persistedChainState }
        : {}),
      ...(delegate.persistedChainStateKind
        ? { persistedChainStateKind: delegate.persistedChainStateKind }
        : {}),
    };
  }
  const planned = delegateFlowRecords.update({
    flowId: delegate.flowId,
    expectedRevision: delegate.expectedRevision,
    fallbackDelegate: { task: delegate.task },
    changes: {
      chainTokensFold: null,
      persistedChainState: chainState,
      persistedChainStateKind: kind,
    },
    patch: { updatedAt: Date.now() },
  });
  if (!planned.applied) {
    throw new Error(
      `planned delegate chain-state marker was not committed for flow ${delegate.flowId}`,
    );
  }
  const plannedDelegate = decodeDelegateFlow(planned.flow);
  if (!plannedDelegate) {
    throw new Error(`planned delegate chain-state marker was corrupt for flow ${delegate.flowId}`);
  }
  return plannedDelegate;
}

export function peekSoonestUnmaturedDelegateDueAt(
  sessionKey: string,
  options: Pick<PendingDelegateCutoffOptions, "queuedCreatedAtOrBefore"> = {},
): number | undefined {
  const now = Date.now();
  let soonest: number | undefined;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    if (
      options.queuedCreatedAtOrBefore !== undefined &&
      flow.createdAt > options.queuedCreatedAtOrBefore
    ) {
      continue;
    }
    const delegate = decodeDelegateFlow(flow);
    if (!delegate) {
      continue;
    }
    const dueAt = delegateDueAt(flow, delegate);
    if (dueAt > now && (soonest === undefined || dueAt < soonest)) {
      soonest = dueAt;
    }
  }
  return soonest;
}

export function pendingDelegateCount(sessionKey: string): number {
  return listQueuedPendingFlows(sessionKey).length;
}

export function hasRecoverablePendingDelegate(sessionKey: string): boolean {
  return delegateFlowRecords.listForOwner(sessionKey).some(isRecoverablePendingFlow);
}

export function annotateQueuedDelegatesChainTokensFold(
  sessionKey: string,
  chainTokensFold: number,
): number {
  if (!(chainTokensFold > 0)) {
    return 0;
  }
  let annotated = 0;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    const delegate = decodeDelegateFlow(flow);
    if (!delegate) {
      continue;
    }
    const result = delegateFlowRecords.update({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      changes: { chainTokensFold },
      patch: { updatedAt: Date.now() },
    });
    if (result.applied) {
      annotated += 1;
    }
  }
  return annotated;
}

function clearDelegatesChainTokensFold(flows: readonly DelegateFlowRecord[]): number {
  let cleared = 0;
  for (const flow of flows) {
    const delegate = decodeDelegateFlow(flow);
    if (!delegate?.chainTokensFold) {
      continue;
    }
    const result = delegateFlowRecords.update({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      changes: { chainTokensFold: null },
      patch: { updatedAt: Date.now() },
    });
    if (result.applied) {
      cleared += 1;
    }
  }
  return cleared;
}

export function clearQueuedDelegatesChainTokensFold(sessionKey: string): number {
  return clearDelegatesChainTokensFold(listQueuedPendingFlows(sessionKey));
}

export function clearRecoverableDelegatesChainTokensFold(sessionKey: string): number {
  return clearDelegatesChainTokensFold(
    delegateFlowRecords.listForOwner(sessionKey).filter(isRecoverablePendingFlow),
  );
}

export function annotateQueuedDelegatesInheritedPolicy(
  sessionKey: string,
  policy: { inheritedSilent?: boolean; inheritedWake?: boolean },
): number {
  if (policy.inheritedSilent !== true && policy.inheritedWake !== true) {
    return 0;
  }
  let annotated = 0;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    const delegate = decodeDelegateFlow(flow);
    if (!delegate || delegate.mode !== undefined) {
      continue;
    }
    const result = delegateFlowRecords.update({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      changes: {
        ...(policy.inheritedSilent ? { inheritedSilent: true } : {}),
        ...(policy.inheritedWake ? { inheritedWake: true } : {}),
      },
      patch: { updatedAt: Date.now() },
    });
    if (result.applied) {
      annotated += 1;
    }
  }
  return annotated;
}

export function cancelPendingDelegates(sessionKey: string): void {
  for (const flow of delegateFlowRecords
    .listForOwner(sessionKey)
    .filter(
      (candidate) => isPendingDelegateFlow(candidate) || isPostCompactionDelegateFlow(candidate),
    )) {
    delegateFlowRecords.delete(flow.flowId);
  }
}

/** Stage the TaskFlow-domain value used by the tool and recovery dispatcher. */
export function stagePostCompactionTaskFlowDelegate(
  sessionKey: string,
  delegate: StagedPostCompactionDelegate,
) {
  const pendingDelegate: PendingContinuationDelegate = {
    task: delegate.task,
    mode: "post-compaction",
    firstArmedAt: delegate.firstArmedAt ?? delegate.stagedAt,
    ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
    ...(delegate.attachAs ? { attachAs: delegate.attachAs } : {}),
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
  });
}

export function removeUnacceptedContinuationDelegate(flowId: string): void {
  delegateFlowRecords.delete(flowId);
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
  const currentDelegate = decodeDelegateFlow(flow) ?? {
    task: delegate.task,
    mode: "post-compaction" as const,
  };
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

export function requeueAwaitingNextCompactionDelegates(options: {
  runningUpdatedAtOrBefore: number;
}): number {
  let requeued = 0;
  for (const flow of delegateFlowRecords.listAll()) {
    if (
      !isPostCompactionDelegateFlow(flow) ||
      flow.status !== "running" ||
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

export function failQueuedDelegatesCreatedAtOrAfter(
  sessionKey: string,
  createdAtOrAfter: number,
  blockedSummary: string,
): number {
  let failed = 0;
  for (const flow of delegateFlowRecords.listForOwner(sessionKey)) {
    if (
      !isRecoverableContinuationDelegateFlow(flow) ||
      flow.status !== "queued" ||
      flow.createdAt < createdAtOrAfter
    ) {
      continue;
    }
    const result = delegateFlowRecords.fail({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: "Rejected replay-unsafe continuation delegate election",
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
  for (const flow of delegateFlowRecords.listAll()) {
    if (!isPostCompactionDelegateFlow(flow) || flow.status !== "running") {
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
    ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
    ...(delegate.attachAs ? { attachAs: delegate.attachAs } : {}),
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

export function resetDelegateStoreForTests(): void {
  resetDelegateFlowDiagnosticsForTests();
}
