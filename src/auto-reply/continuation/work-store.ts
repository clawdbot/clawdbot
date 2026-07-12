/**
 * Durable continue_work store — TaskFlow-backed same-session continuation.
 *
 * `continue_work` elects another turn in the same session. The volatile timer is
 * only a maturity wake; the election itself lives in TaskFlow so gateway restart
 * can re-arm it and subagent cleanup can retain the session until the wake is
 * delivered.
 */

import { z } from "zod";
import { normalizeDiagnosticTraceparent } from "../../infra/diagnostic-trace-context-pure.js";
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

const log = createSubsystemLogger("continuation/work-store");

export const CONTINUATION_WORK_CONTROLLER_ID = "core/continuation-work";

const PendingWorkStateSchema = z.object({
  kind: z.literal("continuation_work"),
  sessionKey: z.string().min(1),
  hop: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  electedAt: z.number().int().nonnegative(),
  dueAt: z.number().int().nonnegative(),
  // Retry/recovery eligibility timestamp. `dueAt` remains the semantic maturity
  // time for anchored rows; recoveryDueAt only delays redelivery attempts.
  recoveryDueAt: z.number().int().nonnegative().optional(),
  maxChainLength: z.number().int().positive(),
  chainStartedAt: z.number().int().nonnegative().optional(),
  accumulatedChainTokens: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  parentRunId: z.string().optional(),
  chainId: z.string().optional(),
  traceparent: z.string().optional(),
  traceparentProvenance: z.literal("internal").optional(),
  // Finalization anchor + provenance. Origin identity is audit-only and must
  // stay separate from parentRunId so same-session work never becomes orphan-
  // reap eligible through its electing run.
  anchorPending: z.boolean().optional(),
  anchorFinalizedAt: z.number().int().nonnegative().optional(),
  originRunId: z.string().optional(),
  originTurnId: z.string().optional(),
  releasedAt: z.number().int().nonnegative().optional(),
  deliveredAt: z.number().int().nonnegative().optional(),
  turnGrantedAt: z.number().int().nonnegative().optional(),
  foldedAt: z.number().int().nonnegative().optional(),
  overdueByMs: z.number().int().nonnegative().optional(),
  disposition: z.enum(["granted", "folded-active"]).optional(),
  retryCount: z.number().int().nonnegative().optional(),
  // Consecutive PRE-drive busy-skip (requests-in-flight/draining/queue-busy)
  // count for diagnostics and rate state. DISTINCT from retryCount — a busy-skip
  // is a legit defer, never a failed attempt, so it must not feed the fail-bound.
  busySkipCount: z.number().int().nonnegative().optional(),
  // Event-driven busy retry: when a wake is blocked by an active turn or the
  // main lane, the row parks behind the matching idle event and keeps a slow
  // hedge timer only as loss recovery.
  idleRetry: z
    .object({
      trigger: z.enum(["reply-run-ended", "command-lane-idle"]),
      reasonCategory: z.enum(["follow-up-work", "wait-shaped", "unknown"]),
      armedAt: z.number().int().nonnegative(),
    })
    .optional(),
  // #990 locus-3: durable delivered-mark written AFTER a wake is confirmed
  // delivered but BEFORE the persist-gap that precedes finishFlow. The
  // consume read-guard skips any flow carrying it so a crash in that window
  // never re-delivers (restart-gap dup cure). Two-axis legible: PRESENT=terminal.
  succeeded: z.object({ point: z.literal("optimal"), durability: z.literal("durable") }).optional(),
});

type PendingWorkState = z.infer<typeof PendingWorkStateSchema>;

export type ContinuationWorkReasonCategory = "follow-up-work" | "wait-shaped" | "unknown";

export type PendingContinuationIdleRetry = {
  trigger: "reply-run-ended" | "command-lane-idle";
  reasonCategory: ContinuationWorkReasonCategory;
  armedAt: number;
};

export type PendingContinuationWork = {
  sessionKey: string;
  hop: number;
  delayMs: number;
  electedAt: number;
  dueAt: number;
  recoveryDueAt?: number;
  maxChainLength: number;
  chainStartedAt?: number;
  accumulatedChainTokens?: number;
  reason?: string;
  parentRunId?: string;
  chainId?: string;
  traceparent?: string;
  anchorPending?: boolean;
  anchorFinalizedAt?: number;
  originRunId?: string;
  originTurnId?: string;
  deliveredAt?: number;
  foldedAt?: number;
  overdueByMs?: number;
  disposition?: "granted" | "folded-active";
  retryCount?: number;
  // Consecutive busy-skip count for diagnostics/rate state. Distinct from
  // retryCount (the transient-error fail-bound). Never penalizes.
  busySkipCount?: number;
  idleRetry?: PendingContinuationIdleRetry;
  // #990 locus-3: durable delivered-mark (see schema). PRESENT once a wake was
  // confirmed delivered; the consume read-guard refuses to re-drive it.
  succeeded?: { point: "optimal"; durability: "durable" };
  flowId?: string;
  expectedRevision?: number;
  // Durable flow status carried onto the runtime object by the store reader
  // ({@link workToRuntime}), sourced from the flow's PRE-claim status. The
  // fold-side write-guard (#988-P2-1) needs this to tell a recovered `running`
  // turn (actively executing) from genuine `queued` backlog so a live turn is
  // never finished-as-superseded. Absent on freshly-constructed enqueue inputs;
  // only store reads populate it.
  status?: "queued" | "running";
};

function isContinuationWorkFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === CONTINUATION_WORK_CONTROLLER_ID;
}

function isRecoverableWorkFlow(flow: TaskFlowRecord): boolean {
  return isContinuationWorkFlow(flow) && (flow.status === "queued" || flow.status === "running");
}

function decodeWorkState(flow: TaskFlowRecord): PendingWorkState | undefined {
  const parsed = PendingWorkStateSchema.safeParse(flow.stateJson);
  return parsed.success ? parsed.data : undefined;
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

function workGoal(work: PendingContinuationWork): string {
  const reason = work.reason?.trim();
  return reason ? `Continuation work: ${reason.slice(0, 80)}` : "Continuation work";
}

function workToRuntime(
  flow: TaskFlowRecord,
  state: PendingWorkState,
  status: "queued" | "running",
): PendingContinuationWork {
  return {
    sessionKey: state.sessionKey,
    hop: state.hop,
    delayMs: state.delayMs,
    electedAt: state.electedAt,
    dueAt: state.dueAt,
    ...(state.recoveryDueAt !== undefined ? { recoveryDueAt: state.recoveryDueAt } : {}),
    maxChainLength: state.maxChainLength,
    ...(state.chainStartedAt !== undefined ? { chainStartedAt: state.chainStartedAt } : {}),
    ...(state.accumulatedChainTokens !== undefined
      ? { accumulatedChainTokens: state.accumulatedChainTokens }
      : {}),
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
    ...(state.chainId ? { chainId: state.chainId } : {}),
    ...(state.traceparent && state.traceparentProvenance === "internal"
      ? { traceparent: state.traceparent }
      : {}),
    ...(state.anchorPending !== undefined ? { anchorPending: state.anchorPending } : {}),
    ...(state.anchorFinalizedAt !== undefined
      ? { anchorFinalizedAt: state.anchorFinalizedAt }
      : {}),
    ...(state.originRunId ? { originRunId: state.originRunId } : {}),
    ...(state.originTurnId ? { originTurnId: state.originTurnId } : {}),
    ...(state.deliveredAt !== undefined ? { deliveredAt: state.deliveredAt } : {}),
    ...(state.foldedAt !== undefined ? { foldedAt: state.foldedAt } : {}),
    ...(state.overdueByMs !== undefined ? { overdueByMs: state.overdueByMs } : {}),
    ...(state.disposition !== undefined ? { disposition: state.disposition } : {}),
    ...(state.retryCount !== undefined ? { retryCount: state.retryCount } : {}),
    ...(state.busySkipCount !== undefined ? { busySkipCount: state.busySkipCount } : {}),
    ...(state.idleRetry ? { idleRetry: state.idleRetry } : {}),
    ...(state.succeeded ? { succeeded: state.succeeded } : {}),
    status,
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  };
}

export function enqueuePendingWork(work: PendingContinuationWork): PendingContinuationWork | null {
  const traceparent = normalizeDiagnosticTraceparent(work.traceparent);
  const state: PendingWorkState = {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    ...(work.recoveryDueAt !== undefined ? { recoveryDueAt: work.recoveryDueAt } : {}),
    maxChainLength: work.maxChainLength,
    ...(work.chainStartedAt !== undefined ? { chainStartedAt: work.chainStartedAt } : {}),
    ...(work.accumulatedChainTokens !== undefined
      ? { accumulatedChainTokens: work.accumulatedChainTokens }
      : {}),
    ...(work.reason ? { reason: work.reason } : {}),
    ...(work.parentRunId ? { parentRunId: work.parentRunId } : {}),
    ...(work.chainId ? { chainId: work.chainId } : {}),
    ...(traceparent ? { traceparent, traceparentProvenance: "internal" as const } : {}),
    ...(work.originRunId ? { originRunId: work.originRunId } : {}),
    ...(work.originTurnId ? { originTurnId: work.originTurnId } : {}),
    // #1135: a continue_work captured during an active turn parks on the
    // end-of-turn lifecycle event from the moment it is enqueued, so the marker
    // must survive the durable write (not just live on the runtime object).
    // Anchors persist too so delayed work remains tied to the electing turn's
    // finalization across gateway restart.
    ...(work.anchorPending !== undefined ? { anchorPending: work.anchorPending } : {}),
    ...(work.anchorFinalizedAt !== undefined ? { anchorFinalizedAt: work.anchorFinalizedAt } : {}),
    ...(work.busySkipCount !== undefined ? { busySkipCount: work.busySkipCount } : {}),
    ...(work.idleRetry ? { idleRetry: work.idleRetry } : {}),
  };
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
    // #990 Pillar-0 (:259 dedup harden): a cancel-requested flow is terminating
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
    // #990 locus-3 read-guard: a durably delivered-marked flow was confirmed
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
    // write-guard (#988-P2-1) keys off this original status.
    const originalStatus: "queued" | "running" = flow.status === "running" ? "running" : "queued";
    work.push(workToRuntime(claimed.flow, { ...state, releasedAt }, originalStatus));
  }
  return work;
}

function buildFallbackWorkState(work: PendingContinuationWork): PendingWorkState {
  return {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    ...(work.recoveryDueAt !== undefined ? { recoveryDueAt: work.recoveryDueAt } : {}),
    maxChainLength: work.maxChainLength,
    ...(work.anchorPending !== undefined ? { anchorPending: work.anchorPending } : {}),
    ...(work.anchorFinalizedAt !== undefined ? { anchorFinalizedAt: work.anchorFinalizedAt } : {}),
    ...(work.originRunId ? { originRunId: work.originRunId } : {}),
    ...(work.originTurnId ? { originTurnId: work.originTurnId } : {}),
  };
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
 * Shared by the turn-granted, superseded (#986), and orphan-reaped (#990) paths:
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
): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
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
    return false;
  }
  work.expectedRevision = updated.flow.revision;
  work.disposition = "folded-active";
  work.foldedAt = params.foldedAt;
  work.overdueByMs = params.overdueByMs;
  work.busySkipCount = 0;
  work.succeeded = succeeded;
  return true;
}

/**
 * Durably mark a continuation wake delivered, BEFORE the persist-gap (#990 locus-3).
 *
 * Written the instant a wake is confirmed delivered (the agent turn ran),
 * before the dispatch loop's follow-on {@link markPendingWorkTurnGranted}
 * finalizes the flow. The flow stays `running`; only `stateJson.succeeded` is
 * set, so a crash in the deliver→finalize window leaves a row the consume
 * read-guard recognizes as delivered (no restart-gap re-delivery). The bumped
 * revision and durable marker are threaded back onto `work` so the follow-on
 * finishFlow still applies. INVARIANT (load-bearing): the mark is durably
 * persisted here — an in-memory-only mark is lost with the process and the gap
 * stays open.
 */
export function markPendingWorkDelivered(work: PendingContinuationWork): boolean {
  if (!work.flowId || work.expectedRevision === undefined) {
    return false;
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
    return false;
  }
  work.expectedRevision = updated.flow.revision;
  work.deliveredAt = now;
  work.succeeded = succeeded;
  return true;
}

/**
 * Reconcile a continuation work row whose durable delivered-mark lost the
 * expected-revision race AFTER the provider turn already executed (#1144:
 * revision/cancel race). The turn is spent, so restart-gap replay must be
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

export function markPendingWorkFailed(work: PendingContinuationWork, summary: string): void {
  if (!work.flowId || work.expectedRevision === undefined) {
    return;
  }
  failFlow({
    flowId: work.flowId,
    expectedRevision: work.expectedRevision,
    currentStep: "Continuation work wake failed",
    blockedSummary: summary,
    updatedAt: Date.now(),
  });
}

/**
 * Mark a matured continuation-work flow superseded (#986 drain-superseded).
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
 * #1135 cross-turn coalesce — fold any still-queued end-of-turn-parked wakes for
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
 * Reap an orphan continuation-work flow (#990 bucket-1 cull).
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
    // #990 locus-3: a delivered-marked flow stuck `running` (crash before
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
 * The #986 maxPendingWork cap uses this rather than {@link pendingWorkCount}
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
    // #990 P2 (#996): a durably delivered-marked flow is DONE, not live. The
    // locus-3 mark deliberately leaves it `status:running` until finishFlow
    // finalizes it; if the process crashed in the mark->finishFlow gap, the row
    // stays `running` but is already delivered. The consume-guards (:221, :485)
    // already exclude `state.succeeded` rows from re-delivery; the cleanup
    // live-check must match, or `deleteSubagentSessionForCleanup` /
    // the registry sweep treat the delivered row as live and strand its child
    // session forever. Exclude delivered-marked rows here too.
    if (decodeWorkState(flow)?.succeeded) {
      return false;
    }
    return true;
  });
}
