/** Durable same-session continuation_work dispatch. */

import type { SubagentRunLiveness } from "../../agents/subagents/registry/subagent-run-liveness.js";
import { emitContinuationWorkSpan } from "../../infra/continuation-tracer.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { clampDelayMs, resolveContinuationRuntimeConfig } from "./config.js";
import { checkContinuationBudget } from "./scheduler.js";
import type { ChainState, ContinuationRuntimeConfig, ContinueWorkRequest } from "./types.js";
import {
  commitFoldedContinuationWork,
  executePendingContinuationWork,
  getContinuationReplyRunRegistry,
  prepareFoldedContinuationWork,
  type ContinuationWorkExecutionDirective,
  type ContinuationWorkIdleRetryTrigger,
} from "./work-dispatch-execution.js";
import type { ContinuationWorkReasonCategory, PendingContinuationWork } from "./work-flow-state.js";
import {
  consumePendingWork,
  enqueuePendingWork,
  finalizeAnchorPendingWork,
  hasPendingIdleRetryWork,
  listPendingWorkSessionKeysForRecovery,
  markPendingWorkSuperseded,
  peekSoonestQueuedWorkDueAt,
  peekSoonestRunningWorkRecoveryDueAt,
  peekSoonestUnmaturedWorkDueAt,
  queuedPendingWorkCount,
  supersedeQueuedTurnEndParkedWork,
} from "./work-store.js";
import { drainPendingTerminalNotices } from "./work-terminal-notice.js";

const log = createSubsystemLogger("continuation/work-dispatch");
const HEDGE_DISPATCH_FAILURE_RETRY_MS = 30_000;
const DISABLED_CONTINUATION_RECHECK_MS = 15_000;
const MAIN_COMMAND_LANE = "main";
const RUNNING_WORK_RECOVERY_STALE_MS = 60_000;
// Guard 2: a matured backlog member is "stale" (superseded-eligible) when it
// is overdue past this multiple of the configured maxDelayMs. Close bursts stay
// below the grace and are NOT collapsed; only a genuine stale pile is folded.
const SUPERSEDED_GRACE_MULTIPLIER = 2;

const workTimers = new Map<string, NodeJS.Timeout>();
const idleRetryFailureTimers = new Map<string, { fireAt: number; handle: NodeJS.Timeout }>();
const idleRetryControllers = new Map<string, AbortController>();

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type DispatchPendingContinuationWorkParams = {
  sessionKey: string;
  recoverRunning?: boolean;
  includeRunningUpdatedAtOrBefore?: number;
  includeIdleRetry?: boolean;
  includeRunningIdleRetry?: boolean;
};

// Timer and idle-wait callbacks inherit the request context that armed them.
// Re-enter at fire time so a released parent root cannot reject the new turn.
function dispatchPendingContinuationWorkFromDetachedCallback(
  params: DispatchPendingContinuationWorkParams,
): Promise<{ dispatched: number; failed: number; reaped: number }> {
  return runWithGatewayIndependentRootWorkAdmission(
    async () => await dispatchPendingContinuationWork(params),
  );
}

function clearWorkTimer(sessionKey: string): void {
  const existing = workTimers.get(sessionKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing);
  workTimers.delete(sessionKey);
}

function clearIdleRetryFailureTimer(sessionKey: string): void {
  const existing = idleRetryFailureTimers.get(sessionKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing.handle);
  idleRetryFailureTimers.delete(sessionKey);
}

function clearIdleRetryControllersForTests(): void {
  for (const controller of idleRetryControllers.values()) {
    controller.abort();
  }
  idleRetryControllers.clear();
}

/** Cancel timers and idle waiters that can re-drive one session's durable work. */
export function clearContinuationWorkDispatch(sessionKey: string): void {
  clearWorkTimer(sessionKey);
  clearIdleRetryFailureTimer(sessionKey);
  for (const trigger of [
    { kind: "reply-run-ended" as const },
    { kind: "command-lane-idle" as const, lane: MAIN_COMMAND_LANE },
  ]) {
    const key = idleRetryTriggerKey(sessionKey, trigger);
    idleRetryControllers.get(key)?.abort();
    idleRetryControllers.delete(key);
  }
}

function armWorkTimer(
  sessionKey: string,
  fireAt: number,
  options: { includeIdleRetry?: boolean } = {},
): void {
  clearWorkTimer(sessionKey);
  const fireIn = Math.max(0, fireAt - Date.now());
  log.info(
    `[continuation:work-hedge-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`,
  );
  const handle = setTimeout(() => {
    workTimers.delete(sessionKey);
    log.info(`[continuation:work-hedge-fired] session=${sessionKey}`);
    void dispatchPendingContinuationWorkFromDetachedCallback({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - RUNNING_WORK_RECOVERY_STALE_MS,
      ...(options.includeIdleRetry ? { includeIdleRetry: true } : {}),
      includeRunningIdleRetry: true,
    })
      .then(() => undefined)
      .catch((err: unknown) => {
        const message = formatErrorMessage(err);
        log.error(`[continuation:work-hedge-error] error=${message} session=${sessionKey}`);
        armNextWorkTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS);
      });
  }, fireIn);
  handle.unref();
  workTimers.set(sessionKey, handle);
}

function armIdleRetryFailureTimer(sessionKey: string, fireAt: number): void {
  const existing = idleRetryFailureTimers.get(sessionKey);
  if (existing && existing.fireAt <= fireAt) {
    return;
  }
  clearIdleRetryFailureTimer(sessionKey);
  const fireIn = Math.max(0, fireAt - Date.now());
  log.info(
    `[continuation:work-idle-retry-recovery-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`,
  );
  const handle = setTimeout(() => {
    idleRetryFailureTimers.delete(sessionKey);
    log.info(`[continuation:work-idle-retry-recovery-fired] session=${sessionKey}`);
    void dispatchPendingContinuationWorkFromDetachedCallback({
      sessionKey,
      includeIdleRetry: true,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - RUNNING_WORK_RECOVERY_STALE_MS,
      includeRunningIdleRetry: true,
    }).catch((err: unknown) => {
      const message = formatErrorMessage(err);
      log.error(
        `[continuation:work-idle-retry-recovery-error] error=${message} session=${sessionKey}`,
      );
      armIdleRetryFailureTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS);
    });
  }, fireIn);
  handle.unref();
  idleRetryFailureTimers.set(sessionKey, { fireAt, handle });
}

export function resetContinuationWorkDispatchForTests(): void {
  for (const handle of workTimers.values()) {
    clearTimeout(handle);
  }
  workTimers.clear();
  for (const { handle } of idleRetryFailureTimers.values()) {
    clearTimeout(handle);
  }
  idleRetryFailureTimers.clear();
  clearIdleRetryControllersForTests();
}

/**
 * rate curve retained for diagnostics/config compatibility.
 *
 * A busy-skip (`requests-in-flight`/`draining`) means the turn never started — a
 * legit defer, never a failed attempt. Older runtime re-armed via this exp-backoff
 * curve; changed the primary retry to idle events and uses the ceiling as
 * the slow hedge. Keep the pure curve for existing config semantics and tests.
 *
 * `busySkipCount` is the PRE-increment prior-skip count so the first computed
 * step yields `baseMs` (factor^0): base, base·f, base·f², … capped at
 * `ceilingMs`. `factor ** n` overflowing to Infinity is harmless — `Math.min`
 * clamps it to the ceiling.
 */
type BusySkipBackoffParams = { baseMs: number; ceilingMs: number; factor: number };

export function computeBusySkipBackoffMs(
  busySkipCount: number,
  params: BusySkipBackoffParams,
): number {
  const exponent = Math.max(0, busySkipCount);
  return Math.min(params.ceilingMs, params.baseMs * params.factor ** exponent);
}

/**
 * bucket-1 — orphan-reap verdict for a busy-deferred continuation flow.
 *
 * Pure decision over the delegate-flow-gate + a read-time parent-liveness join.
 * Asymmetric error cost is load-bearing : wrongly culling a busy seat is
 * unrecoverable; parking a zombie is harmless. So ONLY a confident-terminal
 * parent authorizes the cull — `alive`, `uncertain`, and the no-lineage gate all
 * quiesce (rate-cap-forever, the Pillar-0 trickle).
 */
type BucketOneReapVerdict = "reap" | "rate-cap-forever";

export function bucket1ReapVerdict(
  parentRunId: string | undefined,
  parentLiveness: SubagentRunLiveness,
): BucketOneReapVerdict {
  // Delegate-flow-gate FIRST: a flow with no spawning lineage (same-session
  // continue_work, or a recovered row without parentRunId) is never an orphan we
  // may reap. Never wrongful-reap.
  if (parentRunId == null) {
    return "rate-cap-forever";
  }
  if (parentLiveness === "confident-terminal") {
    return "reap";
  }
  return "rate-cap-forever";
}

function idleRetryTriggerKey(
  sessionKey: string,
  trigger: ContinuationWorkIdleRetryTrigger,
): string {
  return trigger.kind === "reply-run-ended"
    ? `reply:${sessionKey}`
    : `lane:${trigger.lane}:${sessionKey}`;
}

function idleRetryTriggerLabel(
  trigger: ContinuationWorkIdleRetryTrigger,
): "reply-run-ended" | "command-lane-idle" {
  return trigger.kind;
}

function idleRetryTriggerFromWork(
  work: PendingContinuationWork,
): ContinuationWorkIdleRetryTrigger | undefined {
  if (!work.idleRetry) {
    return undefined;
  }
  return work.idleRetry.trigger === "reply-run-ended"
    ? { kind: "reply-run-ended" }
    : { kind: "command-lane-idle", lane: MAIN_COMMAND_LANE };
}

function clearIdleRetryForWork(work: PendingContinuationWork): void {
  const idleRetry = work.idleRetry;
  const trigger = idleRetryTriggerFromWork(work);
  if (!idleRetry || !trigger) {
    return;
  }
  const key = idleRetryTriggerKey(work.sessionKey, trigger);
  const controller = idleRetryControllers.get(key);
  if (!controller) {
    return;
  }
  if (
    hasPendingIdleRetryWork(work.sessionKey, {
      trigger: idleRetry.trigger,
      ...(work.flowId ? { excludeFlowId: work.flowId } : {}),
    })
  ) {
    return;
  }
  controller.abort();
  idleRetryControllers.delete(key);
}

export function classifyContinuationWorkReason(
  reason: string | undefined,
): ContinuationWorkReasonCategory {
  const normalized = reason?.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  const waitMarkers = [
    "yield",
    "stand by",
    "standing by",
    "all tasks complete",
    "tasks complete",
    "external wake",
    "holding position",
    "heartbeat",
    "waiting for",
    "wait for",
  ];
  return waitMarkers.some((marker) => normalized.includes(marker))
    ? "wait-shaped"
    : "follow-up-work";
}

function registerIdleRetry(sessionKey: string, trigger: ContinuationWorkIdleRetryTrigger): void {
  const key = idleRetryTriggerKey(sessionKey, trigger);
  if (idleRetryControllers.has(key)) {
    return;
  }
  const controller = new AbortController();
  idleRetryControllers.set(key, controller);
  const armedAt = Date.now();
  log.info(
    `[continuation:work-idle-retry-armed] trigger=${idleRetryTriggerLabel(trigger)} session=${sessionKey}`,
  );
  void (async () => {
    const idle =
      trigger.kind === "reply-run-ended"
        ? await (async () => {
            const replyRunRegistry = await getContinuationReplyRunRegistry();
            return await replyRunRegistry.waitForIdle(sessionKey, undefined, {
              signal: controller.signal,
            });
          })()
        : await (async () => {
            const { waitForCommandLaneIdle } = await import("../../process/command-queue.js");
            return (
              await waitForCommandLaneIdle(trigger.lane, undefined, {
                signal: controller.signal,
              })
            ).idle;
          })();
    idleRetryControllers.delete(key);
    if (!idle || controller.signal.aborted) {
      return;
    }
    log.info(
      `[continuation:work-idle-retry-fired] trigger=${idleRetryTriggerLabel(trigger)} waitMs=${Date.now() - armedAt} session=${sessionKey}`,
    );
    clearIdleRetryFailureTimer(sessionKey);
    await dispatchPendingContinuationWorkFromDetachedCallback({
      sessionKey,
      includeIdleRetry: true,
    });
  })().catch((err: unknown) => {
    idleRetryControllers.delete(key);
    if (controller.signal.aborted) {
      return;
    }
    const message = formatErrorMessage(err);
    log.error(
      `[continuation:work-idle-retry-error] trigger=${idleRetryTriggerLabel(trigger)} error=${message} session=${sessionKey}`,
    );
    armIdleRetryFailureTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS);
  });
}

function earlierDueAt(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  return right === undefined ? left : Math.min(left, right);
}

function armNextWorkTimer(sessionKey: string, dueAt: number): void {
  const soonestQueued = peekSoonestQueuedWorkDueAt(sessionKey);
  const runningRecoveryDueAt = peekSoonestRunningWorkRecoveryDueAt(
    sessionKey,
    RUNNING_WORK_RECOVERY_STALE_MS,
  );
  const soonest = earlierDueAt(earlierDueAt(dueAt, soonestQueued), runningRecoveryDueAt);
  armWorkTimer(sessionKey, soonest ?? dueAt);
}

/**
 * Guard 2 — partition a matured drain batch into works to drive vs works
 * superseded by a stale backlog.
 *
 * `consumePendingWork` only returns matured (`now >= dueAt`) works, so a batch of
 * >1 is itself the backlog signal: on-time staggered elections fire one-per-poll
 * and never co-drain. Within such a batch we fold the OLDER members that are
 * stale (overdue past `graceMs`) into the newest-elected member, which carries
 * the live intent. Non-stale members (close bursts) always drive; the
 * newest-elected always drives.
 *
 * -1 fold-side write-guard: only `queued` members are supersede-eligible.
 * A recovered `running` member (the recovery path passes `includeRunning`) is a
 * live turn already being driven and ALWAYS drives — it is never folded, even
 * when stale and not newest, so an in-flight turn is never finished-as-superseded
 * out from under itself. Pure for testability.
 */
export function partitionSupersededWork(
  works: readonly PendingContinuationWork[],
  graceMs: number,
  now: number,
): { drive: PendingContinuationWork[]; superseded: PendingContinuationWork[] } {
  if (works.length <= 1 || graceMs <= 0) {
    return { drive: [...works], superseded: [] };
  }
  // Identify the single newest-elected member. A synchronous batch enqueue can
  // stamp identical `electedAt` (the store writes are sync), so ties are broken
  // by `hop` (durable monotonic enqueue order within a chain) — the higher hop
  // is the newer intent. Without the tie-break, same-ms rows fall to array
  // order and the OLDEST stale wake could be kept while the newest is folded
  // (review).
  let newestIdx = 0;
  let newest: PendingContinuationWork | undefined;
  for (const [i, work] of works.entries()) {
    if (
      !newest ||
      work.electedAt > newest.electedAt ||
      (work.electedAt === newest.electedAt && work.hop > newest.hop)
    ) {
      newestIdx = i;
      newest = work;
    }
  }
  const drive: PendingContinuationWork[] = [];
  const superseded: PendingContinuationWork[] = [];
  for (const [i, work] of works.entries()) {
    // -1 fold-side write-guard: a recovered `running` member is live
    // intent already being driven (it may be observing requests-in-flight). It
    // is NEVER supersede-eligible, regardless of staleness or election order —
    // folding it would finish an in-flight turn as superseded out from under
    // itself. Only `queued` backlog members can be coalesced into the newest.
    if (work.status === "running") {
      drive.push(work);
      continue;
    }
    const isNewest = i === newestIdx;
    const isStale = now - work.dueAt > graceMs;
    if (isNewest) {
      // The single newest-elected member always drives (live intent).
      drive.push(work);
    } else if (isStale) {
      superseded.push(work);
    } else {
      drive.push(work);
    }
  }
  return { drive, superseded };
}

function applyExecutionDirective(directive: ContinuationWorkExecutionDirective): void {
  if (directive.kind !== "requeued") {
    return;
  }
  armNextWorkTimer(directive.sessionKey, directive.dueAt);
  if (directive.retryTrigger) {
    registerIdleRetry(directive.sessionKey, directive.retryTrigger);
  }
}

function executionPolicyForWork(
  work: PendingContinuationWork,
  runtimeConfig: ContinuationRuntimeConfig,
) {
  // busySkipBackoff is always set by resolveContinuationRuntimeConfig; the
  // fallback only covers hand-built fixtures.
  const backoff = runtimeConfig.busySkipBackoff ?? {
    baseMs: 1_000,
    ceilingMs: runtimeConfig.maxDelayMs,
    factor: 2,
  };
  return {
    reasonCategory: classifyContinuationWorkReason(work.reason),
    busyRetryDelayMs: computeBusySkipBackoffMs(work.busySkipCount ?? 0, backoff),
    idleRetryHedgeMs: backoff.ceilingMs,
    mainCommandLane: MAIN_COMMAND_LANE,
    ...(runtimeConfig.orphanReapStaleCutoffMs !== undefined
      ? { orphanReapStaleCutoffMs: runtimeConfig.orphanReapStaleCutoffMs }
      : {}),
  };
}

export async function dispatchPendingContinuationWork(
  params: DispatchPendingContinuationWorkParams,
): Promise<{ dispatched: number; failed: number; reaped: number }> {
  const recoverRunning = params.recoverRunning === true;
  // honor a hot-disabled continuation feature on the LIVE callback path.
  // Startup recovery (recoverPendingContinuationWork) already skips disabled
  // continuation, but an armed work/idle-retry timer that fired before the
  // operator set agents.defaults.continuation.enabled=false would otherwise
  // still consume and drive queued work here — buying provider turns after the
  // feature was disabled. Re-check the live config and bail before consuming or
  // mutating any queued rows (they stay durable/recoverable if re-enabled);
  // replace any due work timer with a non-mutating recheck so a hot re-enable
  // can recover the row without startup or unrelated traffic.
  const runtimeConfig = resolveContinuationRuntimeConfig();
  if (!runtimeConfig.enabled) {
    const recheckAt = Date.now() + DISABLED_CONTINUATION_RECHECK_MS;
    if (params.includeIdleRetry === true || params.includeRunningIdleRetry === true) {
      armIdleRetryFailureTimer(params.sessionKey, recheckAt);
    } else {
      clearIdleRetryFailureTimer(params.sessionKey);
      armWorkTimer(params.sessionKey, recheckAt);
    }
    return { dispatched: 0, failed: 0, reaped: 0 };
  }
  const replyRunRegistry = await getContinuationReplyRunRegistry();
  const sessionActive = replyRunRegistry.isActive(params.sessionKey);
  const activeSessionId = sessionActive
    ? replyRunRegistry.resolveSessionId(params.sessionKey)
    : undefined;
  const runningRecoveryBlockedByActiveReply = recoverRunning && sessionActive;
  if (activeSessionId) {
    finalizeAnchorPendingWork(params.sessionKey, Date.now(), {
      activeSessionId,
      matureOverdueAnchors: true,
    });
  } else {
    finalizeAnchorPendingWork(params.sessionKey, Date.now(), { matureOverdueAnchors: true });
  }
  const works = consumePendingWork(params.sessionKey, {
    includeRunning: recoverRunning && !runningRecoveryBlockedByActiveReply,
    includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore,
    includeIdleRetry: params.includeIdleRetry === true,
    includeRunningIdleRetry: params.includeRunningIdleRetry === true,
  });
  // Guard 2: fold a stale backlog. Only matured works reach here, so a
  // batch of >1 means they piled up (the session was busy through the window);
  // on-time staggered elections drain one-per-poll and never co-arrive.
  const supersededGraceMs = runtimeConfig.maxDelayMs * SUPERSEDED_GRACE_MULTIPLIER;
  const { drive: worksToDrive, superseded } = partitionSupersededWork(
    works,
    supersededGraceMs,
    Date.now(),
  );
  if (superseded.length > 0) {
    for (const stale of superseded) {
      clearIdleRetryForWork(stale);
      const overdueMs = Date.now() - stale.dueAt;
      log.info(
        `[continuation:work-superseded] flowId=${stale.flowId ?? "none"} session=${stale.sessionKey} hop=${stale.hop} overdueMs=${overdueMs} — folded into newer election`,
      );
      markPendingWorkSuperseded(
        stale,
        `Superseded by a newer continue_work election after a ${overdueMs}ms stale backlog.`,
      );
    }
    enqueueSystemEvent(
      `[system:continuation-note] ${superseded.length} stale continue_work wake(s) were folded into the newest election (backlog coalesce).`,
      { sessionKey: params.sessionKey, trusted: true },
    );
  }
  const soonestQueued = peekSoonestUnmaturedWorkDueAt(params.sessionKey);
  const runningRecoveryDueAt = peekSoonestRunningWorkRecoveryDueAt(
    params.sessionKey,
    RUNNING_WORK_RECOVERY_STALE_MS,
  );
  const soonestRunningRecovery =
    runningRecoveryDueAt === undefined
      ? undefined
      : recoverRunning && runningRecoveryBlockedByActiveReply
        ? Date.now() + RUNNING_WORK_RECOVERY_STALE_MS
        : runningRecoveryDueAt;
  const soonest = earlierDueAt(soonestQueued, soonestRunningRecovery);
  if (soonest !== undefined) {
    armWorkTimer(params.sessionKey, soonest);
  } else {
    clearWorkTimer(params.sessionKey);
  }

  let dispatched = 0;
  let failed = 0;
  let reaped = 0;
  let worksToGrant = worksToDrive;
  if (sessionActive) {
    const foldWorks = worksToDrive.filter((work) => work.anchorFinalizedAt !== undefined);
    worksToGrant = worksToDrive.filter((work) => work.anchorFinalizedAt === undefined);
    if (foldWorks.length > 0) {
      const foldCandidates = foldWorks.map((work) => ({
        work,
        reasonCategory: classifyContinuationWorkReason(work.reason),
      }));
      const foldAttempt = await prepareFoldedContinuationWork(params.sessionKey, foldCandidates, {
        deliveryTimeoutMs: HEDGE_DISPATCH_FAILURE_RETRY_MS,
        retryDelayMs: HEDGE_DISPATCH_FAILURE_RETRY_MS,
      });
      // Match the durable ordering: transcript proof first, then lifecycle-owned
      // controller cleanup, then the execution owner's row transitions.
      for (const work of foldWorks) {
        clearIdleRetryForWork(work);
      }
      const foldResult = commitFoldedContinuationWork(
        params.sessionKey,
        foldCandidates,
        foldAttempt,
      );
      for (const directive of foldResult.requeues) {
        applyExecutionDirective(directive);
      }
    }
  }
  for (const work of worksToGrant) {
    clearIdleRetryForWork(work);
    const directive = await executePendingContinuationWork(
      work,
      executionPolicyForWork(work, runtimeConfig),
    );
    applyExecutionDirective(directive);
    if (directive.kind === "dispatched") {
      dispatched++;
    } else if (directive.kind === "failed") {
      failed++;
    } else if (directive.kind === "reaped") {
      reaped++;
    }
  }
  return { dispatched, failed, reaped };
}

export async function scheduleContinuationWork(params: {
  sessionKey: string;
  chainState: ChainState;
  request: { delaySeconds: number; reason: string; traceparent?: string };
  config: ContinuationRuntimeConfig;
  parentRunId?: string;
  originRunId?: string;
  originTurnId?: string;
  log?: (message: string) => void;
}): Promise<{ scheduled: boolean; capped: boolean; chainState: ChainState }> {
  const budgetCheck = checkContinuationBudget({
    chainState: params.chainState,
    config: params.config,
    sessionKey: params.sessionKey,
  });
  if (budgetCheck) {
    params.log?.(
      `[continuation:work-rejected] ${budgetCheck} for ${params.sessionKey}: ${params.chainState.currentChainCount}/${params.config.maxChainLength}`,
    );
    return { scheduled: false, capped: true, chainState: params.chainState };
  }

  // Guard 1: per-session concurrent pending-work cap. Orthogonal to the
  // chain-depth cap above — this bounds how many undelivered wakes may coexist
  // (the multi-continue_work flood foot-gun). Enforced at enqueue so a flood can
  // never pile up beyond the cap regardless of chain depth. Treated as a cap
  // (capped: true) so the batch ends early with partial-success preserved.
  // Counts only QUEUED (future) wakes — not the currently-driving `running`
  // flow — so a serial chain at maxPendingWork:1 can still schedule its own
  // successor (the active wake is excluded; see queuedPendingWorkCount).
  const pending = queuedPendingWorkCount(params.sessionKey);
  if (pending >= params.config.maxPendingWork) {
    params.log?.(
      `[continuation:work-rejected] pending-capped for ${params.sessionKey}: ${pending}/${params.config.maxPendingWork}`,
    );
    return { scheduled: false, capped: true, chainState: params.chainState };
  }

  const hop = params.chainState.currentChainCount + 1;
  const delayMs = clampDelayMs(params.request.delaySeconds * 1000, params.config);
  const electedAt = Date.now();
  const dueAt = electedAt + delayMs;
  const nextState: ChainState = {
    currentChainCount: hop,
    chainStartedAt: params.chainState.chainStartedAt,
    accumulatedChainTokens: params.chainState.accumulatedChainTokens,
    ...(params.chainState.chainId ? { chainId: params.chainState.chainId } : {}),
  };

  // any continue_work captured while the electing turn is still
  // active anchors to that turn's finalization, not the tool-call timestamp or a
  // later unrelated turn. `reason` remains provenance/rate metadata, never an
  // admission gate.
  const replyRunRegistry = await getContinuationReplyRunRegistry();
  const electingTurnActive = replyRunRegistry.isActive(params.sessionKey);
  const recoveryHedgeAt = electedAt + params.config.maxDelayMs;
  const idleRetry = electingTurnActive
    ? ({
        trigger: "reply-run-ended" as const,
        reasonCategory: classifyContinuationWorkReason(params.request.reason),
        armedAt: electedAt,
      } satisfies PendingContinuationWork["idleRetry"])
    : undefined;

  const work: PendingContinuationWork = {
    sessionKey: params.sessionKey,
    hop,
    delayMs,
    electedAt,
    // Anchor-pending work fires on the lifecycle event; dueAt is only the slow
    // lost-event hedge until finalization computes the semantic dueAt.
    dueAt: electingTurnActive ? recoveryHedgeAt : dueAt,
    maxChainLength: params.config.maxChainLength,
    chainStartedAt: params.chainState.chainStartedAt,
    accumulatedChainTokens: params.chainState.accumulatedChainTokens,
    ...(params.request.reason ? { reason: params.request.reason } : {}),
    ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
    ...(params.chainState.chainId ? { chainId: params.chainState.chainId } : {}),
    ...(params.request.traceparent ? { traceparent: params.request.traceparent } : {}),
    ...(params.originRunId ? { originRunId: params.originRunId } : {}),
    ...(params.originTurnId ? { originTurnId: params.originTurnId } : {}),
    ...(electingTurnActive ? { anchorPending: true } : { anchorFinalizedAt: electedAt }),
    ...(idleRetry ? { idleRetry } : {}),
  };
  const enqueued = enqueuePendingWork(work);
  if (!enqueued) {
    return { scheduled: false, capped: false, chainState: params.chainState };
  }
  emitContinuationWorkSpan({
    chainId: params.chainState.chainId,
    chainStepRemaining: params.config.maxChainLength - hop,
    delayMs,
    reason: params.request.reason,
    traceparent: params.request.traceparent,
    log: (message) => params.log?.(message),
  });
  if (electingTurnActive) {
    params.log?.(
      `[continuation:work-parked-on-turn-end] session=${params.sessionKey} hop=${hop} reasonCategory=${idleRetry?.reasonCategory ?? "unknown"}`,
    );
    // Wake on the end-of-turn event; keep only a slow hedge as the lost-event net.
    registerIdleRetry(params.sessionKey, { kind: "reply-run-ended" });
    armNextWorkTimer(params.sessionKey, enqueued.dueAt);
  } else {
    // Let callers persist the advanced chain state before even zero-delay work
    // can start the next turn; the timer fires on the next event-loop tick.
    armNextWorkTimer(params.sessionKey, enqueued.dueAt);
  }
  return { scheduled: true, capped: false, chainState: nextState };
}

type ContinuationWorkBatchResult = {
  /** Elections that successfully enqueued a durable wake. */
  scheduledCount: number;
  /** Elections rejected once the cumulative chain/cost cap was reached. */
  cappedCount: number;
  /** True when a cap rejection ended the batch early. */
  capped: boolean;
  /** Chain state after the last scheduled election; persist this once. */
  chainState: ChainState;
};

/**
 * Schedule every continue_work election captured in a single model turn.
 *
 * A single model response can emit N `continue_work` tool calls; each is its
 * own flow with its own delay/reason and must deliver its own wake. The chain
 * state is threaded across elections so chain/cost caps apply cumulatively.
 *
 * Partial success is load-bearing : when a later election trips the cap,
 * the earlier valid elections MUST stay scheduled — silently dropping them is
 * exactly the regression this batches against. A cap rejection ends the batch
 * because the cumulative chain count only grows, so every later election would
 * hit the same cap.
 */
export async function scheduleContinuationWorkBatch(params: {
  sessionKey: string;
  chainState: ChainState;
  requests: readonly ContinueWorkRequest[];
  config: ContinuationRuntimeConfig;
  parentRunId?: string;
  originRunId?: string;
  originTurnId?: string;
  log?: (message: string) => void;
}): Promise<ContinuationWorkBatchResult> {
  let chainState = params.chainState;
  let scheduledCount = 0;
  // cross-turn coalesce: a new model turn's election(s) supersede any
  // still-queued end-of-turn-parked wake from a PRIOR turn for this session. The
  // courtesy/hold/ack repeat loop never accumulates rows — the newest election
  // carries the live intent and fires once at finalization. Folded BEFORE the
  // batch loop so distinct elections WITHIN this turn are preserved; only
  // prior-turn parked duplicates are folded.
  const folded = supersedeQueuedTurnEndParkedWork(
    params.sessionKey,
    "Superseded by a newer continue_work election before its end-of-turn wake fired.",
  );
  if (folded > 0) {
    params.log?.(
      `[continuation:work-turn-end-parked-coalesced] session=${params.sessionKey} folded=${folded}`,
    );
  }
  for (const request of params.requests) {
    const result = await scheduleContinuationWork({
      sessionKey: params.sessionKey,
      chainState,
      request,
      config: params.config,
      ...(params.parentRunId !== undefined ? { parentRunId: params.parentRunId } : {}),
      ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
      ...(params.originTurnId !== undefined ? { originTurnId: params.originTurnId } : {}),
      ...(params.log ? { log: params.log } : {}),
    });
    if (!result.scheduled) {
      return {
        scheduledCount,
        cappedCount: params.requests.length - scheduledCount,
        capped: result.capped,
        chainState,
      };
    }
    chainState = result.chainState;
    scheduledCount += 1;
  }
  return { scheduledCount, cappedCount: 0, capped: false, chainState };
}

export async function recoverPendingContinuationWork(): Promise<{
  sessions: number;
  dispatched: number;
  failed: number;
  reaped: number;
  terminalNotices: number;
}> {
  // An already-owed terminal notice is a debt from work that ran while
  // continuation was enabled. Disabling the feature afterwards must not strand
  // it, so the drain runs before the enablement gate.
  const terminalNotices = await drainPendingTerminalNotices();
  const runtimeConfig = resolveContinuationRuntimeConfig();
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, failed: 0, reaped: 0, terminalNotices };
  }
  const sessionKeys = listPendingWorkSessionKeysForRecovery();
  const includeRunningUpdatedAtOrBefore = Date.now() - RUNNING_WORK_RECOVERY_STALE_MS;
  let dispatched = 0;
  let failed = 0;
  let reaped = 0;
  for (const sessionKey of sessionKeys) {
    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore,
      includeIdleRetry: true,
    });
    dispatched += result.dispatched;
    failed += result.failed;
    reaped += result.reaped;
  }
  return { sessions: sessionKeys.length, dispatched, failed, reaped, terminalNotices };
}
