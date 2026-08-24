/**
 * Durable continue_work store — TaskFlow-backed same-session continuation.
 *
 * `continue_work` elects another turn in the same session. The volatile timer is
 * only a maturity wake; the election itself lives in TaskFlow so gateway restart
 * can re-arm it and subagent cleanup can retain the session until the wake is
 * delivered.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  failFlow,
  finishFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  listTaskFlowsForOwnerKey,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-runtime-internal.js";
import {
  CONTINUATION_WORK_CONTROLLER_ID,
  buildFallbackWorkState,
  decodeWorkState,
  encodeWorkState,
  isContinuationWorkFlow,
  isRecoverableWorkFlow,
  workGoal,
  workToRuntime,
  type PendingContinuationIdleRetry,
  type PendingContinuationWork,
  type PendingWorkState,
} from "./work-flow-state.js";

const log = createSubsystemLogger("continuation/work-store");

type PendingWorkDeliveryCommitResult = Readonly<
  | { applied: true; work: PendingContinuationWork }
  | { applied: false; work: PendingContinuationWork }
>;

export type ContinuationWorkTurnFenceResult =
  | { allowed: true }
  | { allowed: false; reason: "cancelled" | "stale" };

/** Re-read a claimed work row at the final synchronous boundary before turn admission. */
export function revalidatePendingWorkForTurn(
  work: Pick<PendingContinuationWork, "flowId" | "expectedRevision">,
): ContinuationWorkTurnFenceResult {
  if (!work.flowId || work.expectedRevision === undefined) {
    return { allowed: false, reason: "stale" };
  }
  const flow = getTaskFlowById(work.flowId);
  if (
    flow &&
    isContinuationWorkFlow(flow) &&
    flow.status === "running" &&
    flow.revision === work.expectedRevision &&
    flow.cancelRequestedAt == null
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: flow?.status === "cancelled" || flow?.cancelRequestedAt != null ? "cancelled" : "stale",
  };
}

function finalizeDeliveredWorkFlow(flow: TaskFlowRecord, state: PendingWorkState): void {
  const now = Date.now();
  const foldedActive = state.disposition === "folded-active";
  const { recoveryDueAt: _recoveryDueAt, ...terminalState } = state;
  const finished = finishFlow({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    currentStep: foldedActive
      ? "folded-into-active-turn: recovered delivered fold note"
      : "Same-session continuation turn granted",
    stateJson: {
      ...terminalState,
      ...(foldedActive
        ? { foldedAt: state.foldedAt ?? now }
        : {
            deliveredAt: state.deliveredAt ?? now,
            turnGrantedAt: state.turnGrantedAt ?? state.deliveredAt ?? now,
          }),
      disposition: state.disposition ?? (foldedActive ? "folded-active" : "granted"),
      busySkipCount: 0,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    log.warn(
      `[continuation:work-delivered-finish-not-committed] flowId=${flow.flowId} expectedRevision=${flow.revision}`,
    );
  }
}

export function enqueuePendingWork(work: PendingContinuationWork): PendingContinuationWork | null {
  const state = encodeWorkState(work);
  const flow = createManagedTaskFlow({
    ownerKey: work.sessionKey,
    ...(work.chainId ? { chainId: work.chainId } : {}),
    controllerId: CONTINUATION_WORK_CONTROLLER_ID,
    notifyPolicy: "silent",
    goal: workGoal(work),
    currentStep: "Queued for same-session continuation wake",
    stateJson: state,
    createdAt: work.electedAt,
  });
  return flow ? workToRuntime(flow, state, "queued") : null;
}

export function listPendingWorkSessionKeysForRecovery(): string[] {
  const keys = listTaskFlowRecords()
    .filter(isRecoverableWorkFlow)
    .map((flow) => flow.ownerKey);
  return [...new Set(keys)].toSorted();
}

export function consumePendingWork(
  sessionKey: string,
  options: {
    includeRunning?: boolean;
    includeRunningUpdatedAtOrBefore?: number;
    includeIdleRetry?: boolean;
    includeRunningIdleRetry?: boolean;
  } = {},
): PendingContinuationWork[] {
  const now = Date.now();
  const work: PendingContinuationWork[] = [];
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)
    .filter(isContinuationWorkFlow)
    .toSorted((a, b) => a.createdAt - b.createdAt)) {
    // Pillar-0 (dedup harden): a cancel-requested flow is terminating
    // — never consume/drive it. cancelFlowById finalizes managed continuation
    // work to `cancelled` synchronously, but a transient revision conflict can
    // leave it cancelRequestedAt-marked yet not-yet-terminal until the
    // maintenance reaper (task-flow-registry.maintenance.ts) finalizes it.
    // Honoring the request here means a cancelled wake is never granted a turn
    // out from under the cancel. Terminal statuses are already excluded below.
    if (flow.cancelRequestedAt != null) {
      continue;
    }
    if (flow.status !== "queued" && flow.status !== "running") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state) {
      log.warn(
        `[continuation:work-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`,
      );
      failFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: "Rejected invalid continuation work payload",
        blockedSummary: "Pending continuation work payload could not be decoded.",
      });
      continue;
    }
    // locus-3 read-guard: a durably delivered-marked flow was confirmed
    // delivered before the persist-gap. Even if its status is still `running`
    // (the process died after the durable mark but before finishFlow finalized
    // it), never re-consume it — that would be a restart-gap double-delivery.
    if (state.succeeded) {
      finalizeDeliveredWorkFlow(flow, state);
      continue;
    }
    if (state.anchorPending === true) {
      continue;
    }
    const canConsumeRunning =
      flow.status === "running" &&
      options.includeRunning === true &&
      (options.includeRunningUpdatedAtOrBefore === undefined ||
        flow.updatedAt <= options.includeRunningUpdatedAtOrBefore);
    if (flow.status !== "queued" && !canConsumeRunning) {
      continue;
    }
    const idleRetryReady =
      state.idleRetry !== undefined &&
      (options.includeIdleRetry === true ||
        (options.includeRunningIdleRetry === true && flow.status === "running"));
    const retryEligibleAt = Math.max(state.dueAt, state.recoveryDueAt ?? state.dueAt);
    if (now < retryEligibleAt && !idleRetryReady) {
      continue;
    }
    const releasedAt = Date.now();
    const claimed = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "running",
        currentStep:
          flow.status === "running"
            ? "Re-driving same-session continuation wake"
            : "Released to continuation wake scheduler",
        stateJson: { ...state, releasedAt },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        endedAt: null,
        updatedAt: releasedAt,
      },
    });
    if (!claimed.applied || !claimed.flow) {
      continue;
    }
    // Carry the PRE-claim durable status: the claim above flips every consumed
    // flow to `running`, so claimed.flow.status can no longer distinguish a
    // recovered active turn from freshly-released queued backlog. The fold-side
    // write-guard keys off this original status.
    const originalStatus: "queued" | "running" = flow.status === "running" ? "running" : "queued";
    work.push(workToRuntime(claimed.flow, { ...state, releasedAt }, originalStatus));
  }
  return work;
}

export function finalizeAnchorPendingWork(
  sessionKey: string,
  anchorFinalizedAt: number,
  options: { activeSessionId?: string; matureOverdueAnchors?: boolean } = {},
): number {
  let anchored = 0;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (
      !isContinuationWorkFlow(flow) ||
      flow.status !== "queued" ||
      flow.cancelRequestedAt != null
    ) {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state || state.succeeded || state.anchorPending !== true) {
      continue;
    }
    if (
      options.activeSessionId !== undefined &&
      (state.originTurnId === undefined || state.originTurnId === options.activeSessionId)
    ) {
      continue;
    }
    const effectiveAnchorFinalizedAt =
      options.matureOverdueAnchors === true && anchorFinalizedAt - state.electedAt >= state.delayMs
        ? anchorFinalizedAt - state.delayMs
        : anchorFinalizedAt;
    const {
      anchorPending: _anchorPending,
      idleRetry: _idleRetry,
      recoveryDueAt: _recoveryDueAt,
      ...stateWithoutPending
    } = state;
    const dueAt = effectiveAnchorFinalizedAt + state.delayMs;
    const updated = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        currentStep: "Anchored same-session continuation wake to electing turn finalization",
        stateJson: {
          ...stateWithoutPending,
          dueAt,
          anchorFinalizedAt: effectiveAnchorFinalizedAt,
        },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        updatedAt: effectiveAnchorFinalizedAt,
      },
    });
    if (updated.applied) {
      anchored++;
    } else {
      log.warn(
        `[continuation:work-anchor-not-committed] flowId=${flow.flowId} expectedRevision=${flow.revision}`,
      );
    }
  }
  return anchored;
}

/**
 * Finish a continuation-work flow cleanly (terminal, no failure/retry).
 *
 * Shared by the turn-granted, superseded, and orphan-reaped paths:
 * each is an INTENTIONAL terminal — the wake will not re-arm — distinct from
 * {@link markPendingWorkFailed} (error path). `stateExtra` carries the
 * path-specific durable state; `turnGrantedAt` is always stamped so the flow
 * reads as delivered/closed by downstream consumers.
 */
function finishContinuationWorkFlow(
  work: PendingContinuationWork,
  params: { currentStep: string; stateExtra?: Record<string, unknown>; notCommittedTag: string },
): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const now = Date.now();
  const baseState: PendingWorkState = state ?? buildFallbackWorkState(work);
  const { idleRetry: _idleRetry, recoveryDueAt: _recoveryDueAt, ...terminalState } = baseState;
  const finished = finishFlow({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    currentStep: params.currentStep,
    stateJson: {
      ...terminalState,
      turnGrantedAt: now,
      ...params.stateExtra,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    log.warn(
      `[continuation:${params.notCommittedTag}] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return finished.applied;
}

export function markPendingWorkTurnGranted(work: PendingContinuationWork): boolean {
  return finishContinuationWorkFlow(work, {
    currentStep: "Same-session continuation turn granted",
    // A flow that drove is no longer busy-deferred — clear the busy counter so
    // the granted record never carries stale retry state.
    stateExtra: { busySkipCount: 0 },
    notCommittedTag: "work-finish-not-committed",
  });
}

export function markPendingWorkFolded(
  work: PendingContinuationWork,
  params: { summary: string; foldedAt: number; overdueByMs: number },
): boolean {
  return finishContinuationWorkFlow(work, {
    currentStep: `folded-into-active-turn: ${params.summary}`.slice(0, 200),
    stateExtra: {
      disposition: "folded-active",
      foldedAt: params.foldedAt,
      overdueByMs: params.overdueByMs,
      busySkipCount: 0,
    },
    notCommittedTag: "work-fold-not-committed",
  });
}

export function markPendingWorkFoldDelivered(
  work: PendingContinuationWork,
  params: { foldedAt: number; overdueByMs: number },
): PendingWorkDeliveryCommitResult {
  if (!work.flowId || work.expectedRevision === undefined) {
    return { applied: false, work };
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const succeeded = { point: "optimal", durability: "durable" } as const;
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    patch: {
      currentStep: "Continuation fold note delivered (durable mark)",
      stateJson: {
        ...(state ?? buildFallbackWorkState(work)),
        disposition: "folded-active",
        foldedAt: params.foldedAt,
        overdueByMs: params.overdueByMs,
        busySkipCount: 0,
        succeeded,
      },
      updatedAt: params.foldedAt,
    },
  });
  if (!updated.applied || !updated.flow) {
    log.warn(
      `[continuation:work-fold-deliver-mark-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
    return { applied: false, work };
  }
  return {
    applied: true,
    work: {
      ...work,
      expectedRevision: updated.flow.revision,
      disposition: "folded-active",
      foldedAt: params.foldedAt,
      overdueByMs: params.overdueByMs,
      busySkipCount: 0,
      succeeded,
    },
  };
}

/**
 * Durably mark a continuation wake delivered, BEFORE the persist-gap (locus-3).
 *
 * Written the instant a wake is confirmed delivered (the agent turn ran),
 * before the dispatch loop's follow-on {@link markPendingWorkTurnGranted}
 * finalizes the flow. The flow stays `running`; only `stateJson.succeeded` is
 * set, so a crash in the deliver→finalize window leaves a row the consume
 * read-guard recognizes as delivered (no restart-gap re-delivery). The returned
 * committed value carries the bumped revision and durable marker so the
 * follow-on finishFlow still applies without mutating caller-owned state.
 * INVARIANT (load-bearing): the mark is durably persisted here — an
 * in-memory-only mark is lost with the process and the gap stays open.
 */
export function markPendingWorkDelivered(
  work: PendingContinuationWork,
): PendingWorkDeliveryCommitResult {
  if (!work.flowId || work.expectedRevision === undefined) {
    return { applied: false, work };
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const now = Date.now();
  const succeeded = { point: "optimal", durability: "durable" } as const;
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    patch: {
      currentStep: "Continuation wake delivered (durable mark)",
      stateJson: {
        ...(state ?? buildFallbackWorkState(work)),
        deliveredAt: now,
        disposition: "granted",
        succeeded,
      },
      updatedAt: now,
    },
  });
  if (!updated.applied || !updated.flow) {
    log.warn(
      `[continuation:work-deliver-mark-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
    return { applied: false, work };
  }
  return {
    applied: true,
    work: {
      ...work,
      expectedRevision: updated.flow.revision,
      deliveredAt: now,
      disposition: "granted",
      succeeded,
    },
  };
}

/**
 * Reconcile a continuation work row whose durable delivered-mark lost the
 * expected-revision race after the provider turn already executed. The turn is
 * spent, so restart-gap replay must be
 * prevented AND the row must not linger `running`: dispatchPendingContinuationWork
 * skips markPendingWorkTurnGranted on this path (work.expectedRevision is stale),
 * so nothing else finalizes it. Terminalize the CURRENT-revision row here — a
 * lingering `running` row would keep live-work bookkeeping and cleanup gates
 * (hasLiveOrRecentlyDispatchedContinuationWork) blocked until a later recovery
 * pass even though the turn is spent. If finishing races too, fail the row
 * non-retryably — dropping a stale row is strictly safer than replaying an
 * already-executed turn.
 *
 * No-ops when the row is gone, already terminal, cancel-owned, or re-queued by
 * another actor: none of those replay THIS turn (a fresh election is a new flow
 * / a deliberate requeue, not a restart-gap redelivery).
 */
export function reconcileUndeliverableGrantedWork(work: PendingContinuationWork): void {
  if (!work.flowId) {
    return;
  }
  const current = getTaskFlowById(work.flowId);
  if (!current || current.status !== "running" || current.cancelRequestedAt != null) {
    return;
  }
  const state = decodeWorkState(current) ?? buildFallbackWorkState(work);
  const { idleRetry: _idleRetry, recoveryDueAt: _recoveryDueAt, ...terminalState } = state;
  const now = Date.now();
  const succeeded = { point: "optimal", durability: "durable" } as const;
  // Finish (terminalize) against the CURRENT revision — the turn already ran, so
  // this is a clean delivered/granted close, not a failure. Stamp both the
  // delivered read-guard and turnGrantedAt so the finished row reads identically
  // to the normal deliver-then-grant path.
  const finished = finishFlow({
    flowId: current.flowId,
    expectedRevision: current.revision,
    currentStep: "Continuation wake delivered (post-race reconcile)",
    stateJson: {
      ...terminalState,
      deliveredAt: state.deliveredAt ?? now,
      turnGrantedAt: now,
      disposition: "granted",
      succeeded,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (finished.applied) {
    return;
  }
  const latest = getTaskFlowById(work.flowId);
  if (!latest || latest.status !== "running" || latest.cancelRequestedAt != null) {
    return;
  }
  failFlow({
    flowId: latest.flowId,
    expectedRevision: latest.revision,
    currentStep: "Continuation turn executed; delivered-mark lost revision race",
    blockedSummary:
      "Provider turn already ran; parking non-retryable to prevent restart-gap replay.",
    updatedAt: Date.now(),
  });
}

export function requeuePendingWork(
  work: PendingContinuationWork,
  params: {
    dueAt: number;
    summary: string;
    retryCount?: number;
    busySkipCount?: number;
    idleRetry?: PendingContinuationIdleRetry;
  },
): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = current ? decodeWorkState(current) : undefined;
  const baseState: PendingWorkState = state ?? {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    maxChainLength: work.maxChainLength,
  };
  const {
    idleRetry: _idleRetry,
    recoveryDueAt: _recoveryDueAt,
    ...stateWithoutIdleRetry
  } = baseState;
  const preserveSemanticDueAt = baseState.anchorFinalizedAt !== undefined;
  const nextState: PendingWorkState = {
    ...stateWithoutIdleRetry,
    dueAt: preserveSemanticDueAt ? baseState.dueAt : params.dueAt,
    ...(preserveSemanticDueAt ? { recoveryDueAt: params.dueAt } : {}),
    ...(params.retryCount !== undefined ? { retryCount: params.retryCount } : {}),
    ...(params.busySkipCount !== undefined ? { busySkipCount: params.busySkipCount } : {}),
    ...(params.idleRetry ? { idleRetry: params.idleRetry } : {}),
  };
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    patch: {
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
      stateJson: nextState,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: params.summary,
      endedAt: null,
      updatedAt: Date.now(),
    },
  });
  if (!updated.applied) {
    log.warn(
      `[continuation:work-requeue-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return updated.applied;
}

/**
 * Terminalize a continuation-work flow as failed.
 *
 * Returns whether THIS caller committed the terminal transition, mirroring the
 * sibling terminalizers ({@link markPendingWorkSuperseded},
 * {@link markPendingWorkReaped}). The expected-revision CAS is the durable
 * once-only fact: a re-entrant or recovered caller holding a stale claim loses
 * the race and gets `false`, so terminal side effects that must happen exactly
 * once (operator log, agent-visible outcome) can key off the return value
 * instead of a separate dedupe path.
 *
 * `terminalNoticePending` records, in this same CAS write, that the agent still
 * owes a visible outcome. Persisting the obligation atomically with the failure
 * is what makes the notice survive a crash: the in-memory system-event queue is
 * explicitly non-durable, and recovery skips terminal rows unless they carry
 * this flag ({@link listPendingTerminalNoticeWork}).
 */
export function markPendingWorkFailed(
  work: PendingContinuationWork,
  summary: string,
  options: { terminalNoticePending?: "retry-exhausted" } = {},
): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  const state = (current ? decodeWorkState(current) : undefined) ?? buildFallbackWorkState(work);
  return failFlow({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    currentStep: "Continuation work wake failed",
    blockedSummary: summary,
    ...(options.terminalNoticePending
      ? { stateJson: { ...state, terminalNoticePending: options.terminalNoticePending } }
      : {}),
    updatedAt: Date.now(),
  }).applied;
}

/**
 * Every terminalized row still owing the agent a visible outcome.
 *
 * Terminal rows are invisible to {@link listPendingWorkSessionKeysForRecovery}
 * (it only yields queued/running work), so this is the dedicated recovery read
 * for the notice obligation.
 */
export function listPendingTerminalNoticeWork(): PendingContinuationWork[] {
  const pending: PendingContinuationWork[] = [];
  for (const flow of listTaskFlowRecords()) {
    if (!isContinuationWorkFlow(flow) || flow.status !== "failed") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state?.terminalNoticePending) {
      continue;
    }
    pending.push(workToRuntime(flow, state, "running"));
  }
  return pending;
}

/**
 * Read one row's outstanding notice obligation with a current revision.
 *
 * The caller that terminalized the row holds a pre-CAS revision, so it cannot
 * drive the follow-up clear itself; both the live and recovery paths re-read
 * here to act on fresh state.
 */
export function readPendingTerminalNoticeWork(flowId: string): PendingContinuationWork | undefined {
  const flow = getTaskFlowById(flowId);
  if (!flow || !isContinuationWorkFlow(flow) || flow.status !== "failed") {
    return undefined;
  }
  const state = decodeWorkState(flow);
  return state?.terminalNoticePending ? workToRuntime(flow, state, "running") : undefined;
}

/**
 * Release the notice obligation once delivery is durably owned elsewhere.
 *
 * CAS-guarded like every other transition here, so two concurrent drains cannot
 * both hand off the same notice.
 */
export function clearPendingTerminalNotice(work: PendingContinuationWork): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
  }
  const current = getTaskFlowById(work.flowId);
  if (!current) {
    return false;
  }
  const state = decodeWorkState(current);
  if (!state?.terminalNoticePending) {
    return false;
  }
  const { terminalNoticePending: _cleared, ...rest } = state;
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    patch: { stateJson: rest, updatedAt: Date.now() },
  });
  if (!updated.applied) {
    log.warn(
      `[continuation:work-terminal-notice-clear-not-committed] flowId=${work.flowId} expectedRevision=${work.expectedRevision}`,
    );
  }
  return updated.applied;
}

/**
 * Mark a matured continuation-work flow superseded (drain-superseded).
 *
 * Used when a stale backlog member is collapsed in favour of a newer election in
 * the same drain batch — the wake is NOT driven; the flow is finished cleanly so
 * it stops re-arming. Distinct from failure (no system-warning, no retry): a
 * superseded wake was intentionally folded, not dropped by error.
 */
export function markPendingWorkSuperseded(work: PendingContinuationWork, summary: string): boolean {
  return finishContinuationWorkFlow(work, {
    currentStep: `superseded: ${summary}`.slice(0, 200),
    notCommittedTag: "work-supersede-not-committed",
  });
}

/**
 * cross-turn coalesce — fold any still-queued end-of-turn-parked wakes for
 * a session into the newest election about to be scheduled.
 *
 * A continue_work captured during an active turn parks behind that session's
 * end-of-turn event (idleRetry trigger `reply-run-ended`). When a LATER turn
 * elects again before the prior parked wake has fired (the session stayed busy
 * across the window), the prior wake is a redundant duplicate of the same
 * "fire at this session's next finalization" intent — the model re-elected, so
 * the newest election carries the live intent. Folding the prior rows keeps the
 * pending pile bounded (the courtesy/hold/ack repeat loop never accumulates) and
 * delivers exactly one wake at finalization, without dropping anything by reason
 * text. Only end-of-turn-parked `queued` rows are eligible — a future-dated
 * delayed wake (its own offset) and an in-flight `running` turn are never folded.
 * Returns the number of rows folded.
 */
export function supersedeQueuedTurnEndParkedWork(sessionKey: string, summary: string): number {
  let folded = 0;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (!isContinuationWorkFlow(flow) || flow.status !== "queued") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state || state.idleRetry?.trigger !== "reply-run-ended") {
      continue;
    }
    if (markPendingWorkSuperseded(workToRuntime(flow, state, "queued"), summary)) {
      folded++;
    }
  }
  return folded;
}

/**
 * Reap an orphan continuation-work flow (bucket-1 cull).
 *
 * Used when the flow's parent run is CONFIDENT-terminal and can never rehydrate
 * it (read-time liveness join). Finished cleanly like a supersede — no
 * system-warning, no retry — because it is an intentional terminal, not an
 * error. The delegate-flow-gate + confident-terminal requirement upstream
 * guarantee a same-session/uncertain flow is never reaped here.
 */
export function markPendingWorkReaped(work: PendingContinuationWork, summary: string): boolean {
  return finishContinuationWorkFlow(work, {
    currentStep: `reaped: ${summary}`.slice(0, 200),
    notCommittedTag: "work-reap-not-committed",
  });
}

export function peekSoonestUnmaturedWorkDueAt(sessionKey: string): number | undefined {
  const now = Date.now();
  return peekSoonestQueuedWorkDueAt(sessionKey, { after: now });
}

export function peekSoonestQueuedWorkDueAt(
  sessionKey: string,
  options: { after?: number } = {},
): number | undefined {
  let soonest: number | undefined;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (!isContinuationWorkFlow(flow) || flow.status !== "queued") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state) {
      continue;
    }
    const queuedDueAt = Math.max(state.dueAt, state.recoveryDueAt ?? state.dueAt);
    if (options.after !== undefined && queuedDueAt <= options.after) {
      continue;
    }
    soonest = soonest === undefined ? queuedDueAt : Math.min(soonest, queuedDueAt);
  }
  return soonest;
}

export function peekSoonestRunningWorkRecoveryDueAt(
  sessionKey: string,
  staleMs: number,
  now = Date.now(),
): number | undefined {
  let soonest: number | undefined;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (!isContinuationWorkFlow(flow) || flow.status !== "running") {
      continue;
    }
    const state = decodeWorkState(flow);
    if (!state) {
      continue;
    }
    // locus-3: a delivered-marked flow stuck `running` (crash before
    // finishFlow) must not arm a recovery wake — consume would skip it via the
    // read-guard, so re-arming here would spin a tight no-op recovery loop.
    if (state.succeeded) {
      continue;
    }
    const semanticOrRetryDueAt = Math.max(state.dueAt, state.recoveryDueAt ?? state.dueAt);
    const recoveryDueAt =
      state.idleRetry !== undefined
        ? flow.updatedAt + staleMs
        : Math.max(semanticOrRetryDueAt, flow.updatedAt + staleMs);
    if (recoveryDueAt <= now) {
      return now;
    }
    soonest = soonest === undefined ? recoveryDueAt : Math.min(soonest, recoveryDueAt);
  }
  return soonest;
}

export function hasPendingIdleRetryWork(
  sessionKey: string,
  params: { trigger: PendingContinuationIdleRetry["trigger"]; excludeFlowId?: string },
): boolean {
  return listTaskFlowsForOwnerKey(sessionKey).some((flow) => {
    if (!isContinuationWorkFlow(flow) || (flow.status !== "queued" && flow.status !== "running")) {
      return false;
    }
    if (params.excludeFlowId !== undefined && flow.flowId === params.excludeFlowId) {
      return false;
    }
    if (flow.cancelRequestedAt != null) {
      return false;
    }
    const state = decodeWorkState(flow);
    if (!state || state.succeeded) {
      return false;
    }
    return state.idleRetry?.trigger === params.trigger;
  });
}

export function pendingWorkCount(sessionKey: string): number {
  return listTaskFlowsForOwnerKey(sessionKey).filter(isRecoverableWorkFlow).length;
}

/**
 * Count only QUEUED (future, undelivered) continuation-work flows.
 *
 * The maxPendingWork cap uses this rather than {@link pendingWorkCount}
 * (which also counts `running`). At enqueue time the currently-driving wake is
 * still `running` (it is only marked succeeded after `getReplyFromConfig`
 * returns), so counting `running` would make the active wake reject its own
 * serial successor — at `maxPendingWork:1` a normal one-at-a-time chain would
 * self-cap to zero. Counting only `queued` means the cap bounds *future pending*
 * wakes (the flood surface) without penalizing the in-flight driver.
 */
export function queuedPendingWorkCount(sessionKey: string): number {
  return listTaskFlowsForOwnerKey(sessionKey).filter(
    (flow) => isContinuationWorkFlow(flow) && flow.status === "queued",
  ).length;
}

export function hasLiveOrRecentlyDispatchedContinuationWork(sessionKey: string): boolean {
  return listTaskFlowsForOwnerKey(sessionKey).some((flow) => {
    if (!isContinuationWorkFlow(flow)) {
      return false;
    }
    if (flow.status !== "queued" && flow.status !== "running") {
      return false;
    }
    // a durably delivered-marked flow is DONE, not live. The
    // locus-3 mark deliberately leaves it `status:running` until finishFlow
    // finalizes it; if the process crashed in the mark->finishFlow gap, the row
    // stays `running` but is already delivered. The consume guards already exclude
    // `state.succeeded` rows from re-delivery; the cleanup
    // live-check must match, or `deleteSubagentSessionForCleanup` /
    // the registry sweep treat the delivered row as live and strand its child
    // session forever. Exclude delivered-marked rows here too.
    if (decodeWorkState(flow)?.succeeded) {
      return false;
    }
    return true;
  });
}
