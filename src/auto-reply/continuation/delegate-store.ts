/** Canonical continuation-delegate business transitions over TaskFlow. */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  decodeDelegateFlow,
  delegateDueAt,
  delegateFlowRecords,
  isDurablyHandedOffPostCompactionFlow,
  isPendingDelegateFlow,
  isPostCompactionDelegateFlow,
  isRecoverableContinuationDelegateFlow,
  isRecoverablePendingFlow,
  isRecoverablePendingFlowWithinCutoffs,
  isSucceededDelegateFlow,
  isTerminalDelegateFlow,
  listQueuedPendingFlows,
  listRecoverablePendingFlows,
  readAcceptedDelegateChildSessionKey,
  rejectCorruptDelegateFlow,
  resetDelegateFlowDiagnosticsForTests,
  scrubCancellationRequestedDelegateFlowState,
  type PendingDelegateCutoffOptions,
} from "./delegate-flow-store.js";
import type { ChainState, PendingContinuationDelegate } from "./types.js";

const log = createSubsystemLogger("continuation/delegate-store");
type DelegateFlowRecord = ReturnType<typeof delegateFlowRecords.listAll>[number];

export function scrubCancellationRequestedDelegateFlows(
  flows: readonly DelegateFlowRecord[],
): void {
  for (const flow of flows) {
    if (flow.cancelRequestedAt != null) {
      scrubCancellationRequestedDelegateFlowState(flow);
    }
  }
}

export type DelegateSpawnFenceController = "pending" | "post-compaction";

export type DelegateSpawnFenceResult =
  | { allowed: true }
  | { allowed: false; reason: "cancelled" | "stale"; summary: string };

/**
 * Re-read a claimed delegate at the last synchronous boundary before spawn.
 * Once a claim is cancelled or superseded, terminalize its current row so
 * recovery cannot replay stale work.
 */
export function revalidatePendingDelegateForSpawn(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  controller: DelegateSpawnFenceController,
): DelegateSpawnFenceResult {
  const { flowId, expectedRevision } = delegate;
  if ((flowId === undefined) !== (expectedRevision === undefined)) {
    return {
      allowed: false,
      reason: "stale",
      summary: "Continuation delegate source metadata is incomplete before spawn.",
    };
  }
  if (flowId === undefined || expectedRevision === undefined) {
    return { allowed: true };
  }

  let current = delegateFlowRecords.get(flowId);
  const isExpectedController =
    controller === "pending" ? isPendingDelegateFlow : isPostCompactionDelegateFlow;
  const isExpectedClaimRevision =
    current?.revision === expectedRevision && current?.status === "running";
  const isExpectedDurableHandoffRevision =
    controller === "post-compaction" &&
    isDurablyHandedOffPostCompactionFlow(current, expectedRevision);
  if (
    current &&
    isExpectedController(current) &&
    (isExpectedClaimRevision || isExpectedDurableHandoffRevision) &&
    current.cancelRequestedAt == null
  ) {
    return { allowed: true };
  }

  const reason =
    current?.cancelRequestedAt != null || current?.status === "cancelled" ? "cancelled" : "stale";
  const summary =
    reason === "cancelled"
      ? "Continuation delegate cancelled before spawn."
      : "Continuation delegate claim became stale before spawn.";

  for (let attempt = 0; attempt < 2 && current && isExpectedController(current); attempt += 1) {
    if (isTerminalDelegateFlow(current)) {
      if (current.cancelRequestedAt != null) {
        scrubCancellationRequestedDelegateFlowState(current);
      }
      break;
    }
    const failed = delegateFlowRecords.fail({
      flowId: current.flowId,
      expectedRevision: current.revision,
      currentStep:
        reason === "cancelled"
          ? "Cancelled before continuation delegate spawn"
          : "Rejected stale continuation delegate spawn claim",
      blockedSummary: summary,
      updatedAt: Date.now(),
    });
    if (failed.applied || failed.reason === "not_found" || !failed.current) {
      break;
    }
    current = failed.current;
  }

  return { allowed: false, reason, summary };
}

/** Enqueue a delegate from the `continue_delegate` tool. */
export function enqueuePendingDelegate(
  sessionKey: string,
  delegate: PendingContinuationDelegate,
  options: { attachmentConfig?: OpenClawConfig } = {},
) {
  const isPostCompaction = delegate.mode === "post-compaction";
  return delegateFlowRecords.create({
    ownerKey: sessionKey,
    controller: isPostCompaction ? "post-compaction" : "pending",
    delegate,
    currentStep: isPostCompaction
      ? "Staged for release after compaction"
      : "Queued for continuation dispatch",
    attachmentConfig: options.attachmentConfig,
  });
}

export function listPendingDelegateSessionKeysForRecovery(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning"> = {},
): string[] {
  const sessionKeys: string[] = [];
  const flows = delegateFlowRecords.listAll();
  scrubCancellationRequestedDelegateFlows(flows);
  for (const flow of flows) {
    if (
      !isRecoverablePendingFlowWithinCutoffs(flow, {
        includeRunning: true,
        queuedCreatedAtOrBefore: options.queuedCreatedAtOrBefore,
        includeRunningUpdatedAtOrBefore: options.includeRunningUpdatedAtOrBefore,
      })
    ) {
      continue;
    }
    // Validate before the recovery dispatcher attempts to load the owning
    // session. A missing/deleted session must not leave malformed inline bytes
    // in a recoverable TaskFlow row forever.
    if (!decodeDelegateFlow(flow)) {
      rejectCorruptDelegateFlow(flow, { kind: "pending", sessionKey: flow.ownerKey });
      continue;
    }
    sessionKeys.push(flow.ownerKey);
  }
  return [...new Set(sessionKeys)].toSorted();
}

/** Decode cutoff-eligible recovery rows solely to terminalize malformed state. */
export function classifyRecoverablePendingDelegates(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning"> = {},
): void {
  const flows = delegateFlowRecords.listAll();
  scrubCancellationRequestedDelegateFlows(flows);
  for (const flow of flows) {
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
  scrubCancellationRequestedDelegateFlows(delegateFlowRecords.listForOwner(sessionKey));

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
  const expectedRevision = delegate.expectedRevision;
  const now = Date.now();
  if (current && isSucceededDelegateFlow(current)) {
    return recordAcceptedSucceededDelegate(current, expectedRevision, childSessionKey, now);
  }
  const currentDelegate = (current && decodeDelegateFlow(current)) ?? { task: delegate.task };
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
      return recordAcceptedSucceededDelegate(
        finished.current,
        expectedRevision,
        childSessionKey,
        now,
      );
    }
    const message = `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${expectedRevision} acceptance was not committed`;
    log.warn(message);
    if (options.requireWriteSuccess === true) {
      throw new Error(message);
    }
  }
  return finished.applied;
}

function recordAcceptedSucceededDelegate(
  flow: DelegateFlowRecord,
  expectedRevision: number,
  childSessionKey: string,
  now: number,
): boolean {
  const accepted = decodeDelegateFlow(flow);
  const acceptedChildSessionKey = readAcceptedDelegateChildSessionKey(flow);
  if (acceptedChildSessionKey === childSessionKey) {
    return true;
  }
  const canRecordHandedOffChild =
    isPostCompactionDelegateFlow(flow) &&
    acceptedChildSessionKey === undefined &&
    (flow.revision === expectedRevision ||
      isDurablyHandedOffPostCompactionFlow(flow, expectedRevision));
  if (!canRecordHandedOffChild) {
    return false;
  }
  return delegateFlowRecords.update({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    fallbackDelegate: accepted,
    changes: { childSessionKey },
    patch: {
      currentStep: "Accepted by continuation subagent",
      updatedAt: now,
    },
  }).applied;
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
  inheritedPolicy?: Pick<PendingContinuationDelegate, "inheritedSilent" | "inheritedWake">,
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return false;
  }
  const current = delegateFlowRecords.get(delegate.flowId);
  const currentDelegate = (current && decodeDelegateFlow(current)) ?? { task: delegate.task };
  const canInheritPolicy = currentDelegate.mode === undefined || currentDelegate.mode === "normal";
  const requeued = delegateFlowRecords.update({
    flowId: delegate.flowId,
    expectedRevision: delegate.expectedRevision,
    fallbackDelegate: currentDelegate,
    changes: {
      releasedAt: null,
      ...(canInheritPolicy && inheritedPolicy?.inheritedSilent === true
        ? { inheritedSilent: true }
        : {}),
      ...(canInheritPolicy && inheritedPolicy?.inheritedWake === true
        ? { inheritedWake: true }
        : {}),
    },
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

export function peekEarliestQueuedDelegateDueAt(
  sessionKey: string,
  options: Pick<PendingDelegateCutoffOptions, "queuedCreatedAtOrBefore"> = {},
): number | undefined {
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
      rejectCorruptDelegateFlow(flow, { kind: "pending", sessionKey });
      continue;
    }
    const dueAt = delegateDueAt(flow, delegate);
    if (soonest === undefined || dueAt < soonest) {
      soonest = dueAt;
    }
  }
  return soonest;
}

export function pendingDelegateCount(sessionKey: string): number {
  return listQueuedPendingFlows(sessionKey).length;
}

export function hasRecoverablePendingDelegate(sessionKey: string): boolean {
  const flows = delegateFlowRecords.listForOwner(sessionKey);
  scrubCancellationRequestedDelegateFlows(flows);
  return flows.some(isRecoverablePendingFlow);
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
  queuedCreatedAtOrBefore?: number,
): number {
  if (policy.inheritedSilent !== true && policy.inheritedWake !== true) {
    return 0;
  }
  let annotated = 0;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    if (queuedCreatedAtOrBefore !== undefined && flow.createdAt > queuedCreatedAtOrBefore) {
      continue;
    }
    const delegate = decodeDelegateFlow(flow);
    // Persisted normal/default mode is represented by an omitted `mode`.
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

export function removeUnacceptedContinuationDelegate(flowId: string): void {
  delegateFlowRecords.delete(flowId);
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

export function resetDelegateStoreForTests(): void {
  resetDelegateFlowDiagnosticsForTests();
}
