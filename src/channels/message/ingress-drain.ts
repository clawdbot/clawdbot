/**
 * Core-owned durable channel-ingress drain.
 *
 * Owns claim recovery, per-lane serialization, adoption-time complete, retry /
 * dead-letter disposition, pre-adoption stall watchdog, and optional supersede.
 */
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import {
  GatewayDrainingError,
  retainGatewayRootWorkAdmissionContinuation,
  runOutsideGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  createIngressDrainOwnerId,
  deregisterLiveIngressDrainInstance,
  INGRESS_CLAIM_LEASE_MS,
  isIngressClaimOwnedByOtherLiveProcess,
  isIngressCorruptClaimOwnedByOtherLiveProcess,
  isLiveLocalIngressDrainOwner,
  registerLiveIngressDrainInstance,
} from "./ingress-claim-owner.js";
import { createIngressWriter } from "./ingress-claim-writes.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import {
  activeClaimKey,
  createIngressSettleOwner,
  IngressAdoptionLostError,
  resolveLaneKey,
  sortedKeys,
  type ActiveHandlerState,
  type ChannelIngressDrainDispatchResult,
} from "./ingress-drain-state.js";
import { supersedeActiveStatesIfNeeded } from "./ingress-drain-supersede.js";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.js";
import {
  resolveIngressFailureDisposition,
  resolveIngressRetryDelayMs,
  type IngressNonRetryableFailure,
  type IngressRetryPolicyConfig,
} from "./ingress-retry-policy.js";
export { bindIngressLifecycleToReplyOptions } from "./ingress-drain-lifecycle.js";
export { isIngressAdoptionLostError } from "./ingress-drain-state.js";

/** Default claim→adoption stall before applying the shared retry disposition. */
export const DEFAULT_INGRESS_ADOPTION_STALL_MS = 5 * 60 * 1000;

type DeferredLaneOccupancy = "hold" | "release";

export type CreateChannelIngressDrainOptions<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
> = {
  queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
  /**
   * Dispatch a claimed event. Wire lifecycle into reply options (see
   * bindIngressLifecycleToReplyOptions). Return deferred when ownership will
   * transfer at reply-lane admission; otherwise complete or throw.
   */
  dispatchClaimedEvent: (
    event: ChannelIngressQueueClaim<TPayload, TMetadata>,
    lifecycle: ChannelIngressDispatchLifecycle,
  ) => Promise<ChannelIngressDrainDispatchResult | void> | ChannelIngressDrainDispatchResult | void;
  resolveNonRetryableFailure?: (err: unknown) => IngressNonRetryableFailure | null;
  shouldSupersedePending?: (
    newEvent:
      | ChannelIngressQueueRecord<TPayload, TMetadata>
      | ChannelIngressQueueClaim<TPayload, TMetadata>,
    pendingEvent: ChannelIngressQueueClaim<TPayload, TMetadata>,
  ) => boolean | Promise<boolean>;
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean;
  ownerId?: string;
  adoptionStallTimeoutMs?: number;
  claimLeaseMs?: number;
  /**
   * Whether a claimed event keeps occupying its ingress serialization lane after
   * dispatch hands ownership to deferred work. Default "hold" (current behavior).
   */
  deferredLaneOccupancy?: DeferredLaneOccupancy;
  retryPolicy?: IngressRetryPolicyConfig;
  now?: () => number;
  formatError?: (err: unknown) => string;
  onLog?: (message: string) => void;
  abortSignal?: AbortSignal;
  orderBy?: "received" | "id";
  scanLimit?: number;
  startLimit?: number;
};

export type ChannelIngressDrain = {
  recoverStaleClaims: () => Promise<number>;
  drainOnce: (options?: { shouldStop?: () => boolean }) => Promise<{ started: number }>;
  activeLaneKeys: () => ReadonlySet<string>;
  waitForIdle: () => Promise<void>;
  dispose: () => void;
};

/** Creates a channel-agnostic durable ingress drain over an existing queue. */
export function createChannelIngressDrain<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: CreateChannelIngressDrainOptions<TPayload, TMetadata, TCompletedMetadata>,
): ChannelIngressDrain {
  const queue = options.queue;
  // Unique per drain instance so same-process peers do not share claim ownership.
  const ownerId = options.ownerId ?? createIngressDrainOwnerId();
  registerLiveIngressDrainInstance(ownerId);
  const adoptionStallTimeoutMs =
    options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS;
  const claimLeaseMs = options.claimLeaseMs ?? INGRESS_CLAIM_LEASE_MS;
  const now = options.now ?? Date.now;
  const formatError = options.formatError ?? formatErrorMessage;
  const orderBy = options.orderBy ?? "received";
  const scanLimit = Math.max(1, Math.floor(options.scanLimit ?? 100));
  const startLimit = options.startLimit ?? 32;
  const deferredLaneOccupancy = options.deferredLaneOccupancy ?? "hold";
  const activeByClaim = new Map<string, ActiveHandlerState<TPayload, TMetadata>>();
  const laneOwnerByKey = new Map<string, ActiveHandlerState<TPayload, TMetadata>>();
  let disposed = false;

  const log = (message: string) => {
    options.onLog?.(message);
  };

  const clearStallTimer = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    if (state.stallTimer) {
      clearTimeout(state.stallTimer);
      state.stallTimer = undefined;
    }
  };

  const clearClaimRefresh = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    if (state.claimRefreshTimer) {
      clearInterval(state.claimRefreshTimer);
      state.claimRefreshTimer = undefined;
    }
  };

  const abortActiveClaims = () => {
    // Retire before abort so replacements recover; Set.delete makes disposal repeat safe.
    // Claim-token fencing prevents this owner from settling a recovered claim.
    deregisterLiveIngressDrainInstance(ownerId);
    const reason = disposed
      ? new Error("ingress-drain-disposed")
      : toErrorObject(options.abortSignal?.reason, "ingress-drain-aborted");
    for (const state of activeByClaim.values()) {
      if (state.phase === "dispatching" || state.phase === "deferred") {
        // Retire stall detection without blocking a late terminal claim write.
        clearStallTimer(state);
        state.abortController.abort(reason);
      }
    }
  };
  if (options.abortSignal?.aborted) {
    abortActiveClaims();
  } else {
    options.abortSignal?.addEventListener("abort", abortActiveClaims, { once: true });
  }

  const removeActive = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearStallTimer(state);
    clearClaimRefresh(state);
    activeByClaim.delete(activeClaimKey(state.claim));
    if (laneOwnerByKey.get(state.laneKey) === state) {
      laneOwnerByKey.delete(state.laneKey);
    }
    state.occupiesLane = false;
  };

  const markLeaseReclaimed = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    // Guillotine-style closed flag: late onAdopted throws IngressAdoptionLostError.
    // Do not release/fail — another owner holds the claim token.
    if (state.phase === "settled" || state.guillotined || state.superseded) {
      return;
    }
    state.guillotined = true;
    clearStallTimer(state);
    clearClaimRefresh(state);
    try {
      state.abortController.abort(new Error("ingress claim lease reclaimed"));
    } catch {
      // AbortController.abort is not fallible in practice.
    }
  };

  const armClaimRefresh = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearClaimRefresh(state);
    // Keep lease alive until tombstone commits (includes complete-retry wedge).
    const intervalMs = Math.max(1, Math.floor(claimLeaseMs / 3));
    state.claimRefreshTimer = setInterval(() => {
      if (state.phase === "settled" || state.guillotined || state.superseded) {
        clearClaimRefresh(state);
        return;
      }
      if (!queue.refreshClaim) {
        return;
      }
      void queue
        .refreshClaim(state.claim, { refreshedAt: now() })
        .then((refreshed) => {
          // false = claim-token fence rejected (lease reclaimed by another owner).
          if (!refreshed) {
            markLeaseReclaimed(state);
          }
        })
        .catch(() => undefined);
    }, intervalMs);
    state.claimRefreshTimer.unref?.();
  };

  const isStopped = () => disposed || options.abortSignal?.aborted === true;

  const { completeClaimWithRetry, releaseClaim, failClaim } = createIngressWriter(options, {
    queue,
    now,
    formatError,
    log,
    isStopped,
  });

  const applyFailureDisposition = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    err: unknown,
  ) => {
    if (err instanceof GatewayDrainingError) {
      // Root dispatch closes before durable transport admission during restart.
      // Preserve the row for the successor without spending its failure budget.
      await releaseClaim(claim, { recordAttempt: false });
      return;
    }
    const disposition = resolveIngressFailureDisposition({
      err,
      event: claim,
      formatError,
      resolveNonRetryableFailure: options.resolveNonRetryableFailure,
      config: options.retryPolicy,
      now: now(),
    });
    const committed =
      disposition.kind === "fail"
        ? await failClaim(claim, disposition.reason, disposition.message)
        : await releaseClaim(claim, { lastError: disposition.message });
    const displayId = claim.id.replace(/^0+(?=\d)/, "") || claim.id;
    if (!committed) {
      log(`spooled update ${displayId} settlement skipped: claim no longer owns the event`);
      return;
    }
    if (disposition.kind === "fail") {
      log(
        `spooled update ${displayId} failed with non-retryable ${disposition.reason}: ${disposition.message}; dead-lettered`,
      );
      if (disposition.reason === "retry-limit-exceeded") {
        log(
          `spooled update ${displayId} on lane ${claim.laneKey ?? displayId} reached retry limit after ${disposition.attempt} attempts; dead-lettered`,
        );
      }
      return;
    }
    log(`spooled update ${displayId} failed; keeping for retry: ${disposition.message}`);
  };

  const armStallWatchdog = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearStallTimer(state);
    state.stallTimer = setTimeout(() => {
      // Pre-adoption only (dispatching OR deferred). Timer is not cleared by deferral.
      if (state.phase !== "dispatching" && state.phase !== "deferred") {
        return;
      }
      const ageMs = now() - state.startedAt;
      const displayId = state.eventId.replace(/^0+(?=\d)/, "") || state.eventId;
      const message = `Channel ingress claim→adoption stalled for event ${displayId} on lane ${state.laneKey} after ${ageMs}ms; applying retry policy (handler-timeout).`;
      const timeoutError = new Error(message);
      // Closed guillotine flag — catch must not string-sniff errors.
      state.guillotined = true;
      clearStallTimer(state);
      log(message);
      try {
        state.abortController.abort(timeoutError);
      } catch {
        // AbortController.abort is not fallible in practice.
      }
      // Route the timeout through the canonical retry owner. A release/fail write
      // error must not falsely settle (would stop heartbeat and wedge recovery).
      void state
        .settleOnce(async () => {
          await applyFailureDisposition(state.claim, timeoutError);
        })
        .catch((err: unknown) => {
          log(
            `ingress drain: failed to settle stalled event ${displayId}; holding claim: ${formatError(err)}`,
          );
        });
    }, adoptionStallTimeoutMs);
    state.stallTimer.unref?.();
  };

  const releaseUnadopted = async (
    state: ActiveHandlerState<TPayload, TMetadata>,
    releaseOptions: { lastError?: string; recordAttempt?: boolean },
  ) => {
    if (state.phase !== "deferred" && state.phase !== "dispatching") {
      return;
    }
    if (state.guillotined || state.superseded) {
      return;
    }
    clearStallTimer(state);
    await state
      .settleOnce(async () => {
        await releaseClaim(state.claim, releaseOptions);
      })
      .catch(() => undefined);
  };

  const createLifecycle = (
    state: ActiveHandlerState<TPayload, TMetadata>,
  ): ChannelIngressDispatchLifecycle => {
    return {
      abortSignal: state.abortController.signal,
      onAdopted: async () => {
        // Lost adoption is loud: guillotine/supersede already tombstoned/failed the claim.
        if (state.guillotined) {
          throw new IngressAdoptionLostError("guillotined");
        }
        if (state.superseded) {
          throw new IngressAdoptionLostError("superseded");
        }
        if (state.phase === "adopted" || state.phase === "settled") {
          // Idempotent only after a genuine successful adoption path.
          return;
        }
        // Complete at adoption, not settle — frees the lane for later events.
        state.phase = "adopted";
        clearStallTimer(state);
        await state.settleOnce(async () => {
          await completeClaimWithRetry(state.claim);
        });
      },
      onDeferred: () => {
        if (state.phase !== "dispatching") {
          return;
        }
        // Deferred holds the claim; watchdog remains armed until adoption or abandon.
        state.phase = "deferred";
        if (deferredLaneOccupancy === "release") {
          if (laneOwnerByKey.get(state.laneKey) === state) {
            laneOwnerByKey.delete(state.laneKey);
          }
          state.occupiesLane = false;
        }
      },
      onDeferredHeartbeat: () => {
        // Abort also covers disposal; retired callbacks cannot restart the watchdog.
        if (state.phase === "deferred" && !state.abortController.signal.aborted) {
          armStallWatchdog(state);
        }
      },
      onAdoptionFinalizing: () => {
        if (state.phase !== "dispatching" && state.phase !== "deferred") {
          return;
        }
        if (state.guillotined || state.superseded) {
          return;
        }
        // Adoption finalization (settlement hold) owns the claim; do not let a
        // stall watchdog race and dead-letter an about-to-complete event.
        clearStallTimer(state);
      },
      onFailed: async (error) => {
        if (state.phase !== "dispatching" && state.phase !== "deferred") {
          return;
        }
        if (state.guillotined || state.superseded) {
          return;
        }
        // Keep recovery armed until disposition commits; removeActive clears it after success.
        await state.settleOnce(async () => {
          await applyFailureDisposition(state.claim, error);
        });
      },
      onCancelled: async () => {
        // Cancellation means ownership ended before delivery, so preserve every
        // prior retry fact while reopening the canonical row for replacement.
        await releaseUnadopted(state, { recordAttempt: false });
      },
      onAbandoned: async () => {
        await releaseUnadopted(state, { lastError: "turn-abandoned" });
      },
    };
  };

  const supersedeActiveIfNeeded = async (
    candidate: ChannelIngressQueueRecord<TPayload, TMetadata>,
    laneKey: string,
  ): Promise<boolean> =>
    await supersedeActiveStatesIfNeeded({
      candidate,
      laneKey,
      activeByClaim,
      laneOwnerByKey,
      shouldSupersedePending: options.shouldSupersedePending,
      clearStallTimer,
      completeClaim: completeClaimWithRetry,
      formatError,
      log,
    });

  const runClaimed = (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    laneKey: string,
  ): ActiveHandlerState<TPayload, TMetadata> => {
    const abortController = new AbortController();
    const state = {
      eventId: claim.id,
      laneKey,
      claim,
      abortController,
      startedAt: now(),
      phase: "dispatching" as const,
      occupiesLane: true,
      guillotined: false,
      superseded: false,
      task: Promise.resolve(),
      settleOnce: async () => {},
    } as ActiveHandlerState<TPayload, TMetadata>;
    state.settleOnce = createIngressSettleOwner(state, removeActive);
    const lifecycle = createLifecycle(state);
    armStallWatchdog(state);
    armClaimRefresh(state);

    // drainOnce starts dispatches without awaiting them, so this task outlives
    // the admission context it inherits (a detached pump root or the transport
    // request that enqueued the event). Retain a live root until the task
    // settles; when the inherited root is already released, dispatch outside it
    // so the dead lease cannot make session admission refuse the turn as
    // draining. A real restart drain still refuses both paths at admission.
    const releaseRootWork = retainGatewayRootWorkAdmissionContinuation();
    state.task = (async () => {
      try {
        const result = await (releaseRootWork
          ? options.dispatchClaimedEvent(claim, lifecycle)
          : runOutsideGatewayRootWorkAdmission(() =>
              options.dispatchClaimedEvent(claim, lifecycle),
            ));
        // dispose() leaves claims for recovery. Session abort mid-flight
        // (skipped/void) also leaves the claim; a terminal completed/failed
        // result still settles even if abort raced the return.
        if (disposed) {
          return;
        }
        if (
          options.abortSignal?.aborted &&
          result?.kind !== "completed" &&
          result?.kind !== "failed-retryable"
        ) {
          return;
        }
        if (state.phase === "settled" || state.phase === "adopted") {
          return;
        }
        if (state.guillotined || state.superseded) {
          return;
        }
        if (result?.kind === "deferred") {
          lifecycle.onDeferred();
          return;
        }
        if (result?.kind === "failed-retryable") {
          clearStallTimer(state);
          await state.settleOnce(async () => {
            await applyFailureDisposition(claim, result.error);
          });
          return;
        }
        // Default: dispatch returned without deferral — complete when channel
        // did not call onAdopted (channels should prefer lifecycle.onAdopted).
        // Mark adopted BEFORE tombstone retries so a write failure cannot release
        // a claim whose dispatch side effects already ran (replay risk).
        if (state.phase === "dispatching") {
          state.phase = "adopted";
          clearStallTimer(state);
          await state.settleOnce(async () => {
            await completeClaimWithRetry(claim);
          });
        }
      } catch (err) {
        if (isStopped() || state.phase === "settled") {
          return;
        }
        // Guillotine / supersede own settleOnce — do not fail/release again.
        if (state.guillotined || state.superseded) {
          return;
        }
        // Adoption may have partially completed (tombstone retry wedge); keep claim.
        // Includes handler-completed path that moved to adopted before complete().
        if (state.phase === "adopted") {
          log(
            `ingress drain: post-adoption error for event ${claim.id} while claim held: ${formatError(err)}`,
          );
          return;
        }
        clearStallTimer(state);
        await state.settleOnce(async () => {
          await applyFailureDisposition(claim, err);
        });
      } finally {
        releaseRootWork?.();
      }
    })();

    activeByClaim.set(activeClaimKey(claim), state);
    laneOwnerByKey.set(laneKey, state);
    return state;
  };

  const recoverStaleClaims = async (): Promise<number> => {
    const activeLanes = new Set(laneOwnerByKey.keys());
    return await queue.recoverStaleClaims({
      staleMs: 0,
      now: now(),
      shouldRecover: (claim) => {
        if (activeByClaim.has(activeClaimKey(claim))) {
          return false;
        }
        // Same-PID multi-drain: only recover when the owner instance is not live.
        if (isLiveLocalIngressDrainOwner(claim.claim.ownerId)) {
          return false;
        }
        return !isIngressClaimOwnedByOtherLiveProcess(claim, {
          maxAgeMs: claimLeaseMs,
          now: now(),
        });
      },
      shouldRecoverCorrupt: (claim) => {
        if (claim.laneKey && activeLanes.has(claim.laneKey)) {
          return false;
        }
        if (isLiveLocalIngressDrainOwner(claim.claim.ownerId)) {
          return false;
        }
        return !isIngressCorruptClaimOwnedByOtherLiveProcess(claim, {
          maxAgeMs: claimLeaseMs,
          now: now(),
        });
      },
    });
  };

  const drainOnce = async (drainOptions?: {
    shouldStop?: () => boolean;
  }): Promise<{ started: number }> => {
    if (disposed) {
      return { started: 0 };
    }
    const shouldStop = () =>
      disposed || drainOptions?.shouldStop?.() === true || options.abortSignal?.aborted === true;

    await recoverStaleClaims();

    const pending = await queue.listPending({ limit: "all", orderBy });
    const claims = await queue.listClaims();
    const activeLaneKeys = new Set(laneOwnerByKey.keys());
    const claimedLaneKeys = new Set(
      claims
        .filter((claim) => {
          const state = activeByClaim.get(activeClaimKey(claim));
          return !(
            state?.phase === "deferred" &&
            !state.occupiesLane &&
            !state.guillotined &&
            !state.superseded
          );
        })
        .map((claim) =>
          resolveLaneKey(claim, options.deriveLaneKey, options.reconcileStoredLaneKey),
        ),
    );
    const retryDelayedLaneKeys = new Set<string>();
    const pendingLaneKeys = new Set<string>();
    const retryDelayed = new Uint8Array(pending.length);
    // listPending and claimNext share order, so the first row per lane is its head.
    // Delayed tails leave this snapshot so a sibling cannot make them start early.
    for (const [index, event] of pending.entries()) {
      const laneKey = resolveLaneKey(event, options.deriveLaneKey, options.reconcileStoredLaneKey);
      if (resolveIngressRetryDelayMs(event, options.retryPolicy, now()) > 0) {
        retryDelayed[index] = 1;
        if (!pendingLaneKeys.has(laneKey)) {
          retryDelayedLaneKeys.add(laneKey);
        }
      }
      pendingLaneKeys.add(laneKey);
    }

    // Deterministic blocked set for claimNext lane serialization.
    const blockedLaneKeys = new Set<string>([
      ...sortedKeys(activeLaneKeys),
      ...sortedKeys(claimedLaneKeys),
      ...sortedKeys(retryDelayedLaneKeys),
    ]);

    // Optional supersede scan: pending events may abort unadopted same-lane work.
    // Free the lane in blockedLaneKeys so claimNext can take the superseding event.
    for (const event of pending) {
      if (shouldStop()) {
        break;
      }
      const laneKey = resolveLaneKey(event, options.deriveLaneKey, options.reconcileStoredLaneKey);
      if (await supersedeActiveIfNeeded(event, laneKey)) {
        blockedLaneKeys.delete(laneKey);
      }
    }

    const candidateWindow = new Map<string, string>();
    let nextCandidateIndex = 0;
    const refillCandidateWindow = () => {
      for (const [id, laneKey] of candidateWindow) {
        if (blockedLaneKeys.has(laneKey)) {
          candidateWindow.delete(id);
        }
      }
      while (candidateWindow.size < scanLimit && nextCandidateIndex < pending.length) {
        const index = nextCandidateIndex;
        const event = pending[index]!;
        nextCandidateIndex += 1;
        if (retryDelayed[index] === 1) {
          continue;
        }
        const laneKey = resolveLaneKey(
          event,
          options.deriveLaneKey,
          options.reconcileStoredLaneKey,
        );
        if (!blockedLaneKeys.has(laneKey)) {
          candidateWindow.set(event.id, laneKey);
        }
      }
    };

    let started = 0;
    while (started < startLimit) {
      if (shouldStop()) {
        break;
      }
      // Candidate membership freezes this pass to the analyzed snapshot. A
      // scan-sized window avoids binding the full backlog, and the forward-only
      // cursor keeps released rows to one attempt in this pass.
      refillCandidateWindow();
      if (candidateWindow.size === 0) {
        break;
      }
      const claimed = await queue.claimNext({
        ownerId,
        blockedLaneKeys,
        orderBy,
        scanLimit,
        candidateIds: candidateWindow.keys(),
        deriveLaneKey: options.deriveLaneKey,
        ...(options.reconcileStoredLaneKey
          ? { reconcileStoredLaneKey: options.reconcileStoredLaneKey }
          : {}),
      });
      if (!claimed) {
        break;
      }
      // One snapshot row gets one attempt per pass. A released claim remains
      // pending for the next pump instead of spinning through SQLite here.
      candidateWindow.delete(claimed.id);
      if (shouldStop()) {
        await queue.release(claimed, { recordAttempt: false });
        break;
      }
      const laneKey = resolveLaneKey(
        claimed,
        options.deriveLaneKey,
        options.reconcileStoredLaneKey,
      );
      const existing = laneOwnerByKey.get(laneKey);
      if (existing && existing.phase !== "settled") {
        if (await supersedeActiveIfNeeded(claimed, laneKey)) {
          blockedLaneKeys.delete(laneKey);
        }
        if (laneOwnerByKey.has(laneKey)) {
          await queue.release(claimed, { recordAttempt: false });
          blockedLaneKeys.add(laneKey);
          continue;
        }
      }
      runClaimed(claimed, laneKey);
      blockedLaneKeys.add(laneKey);
      started += 1;
    }
    return { started };
  };

  return {
    recoverStaleClaims,
    drainOnce,
    activeLaneKeys: () => new Set(laneOwnerByKey.keys()),
    waitForIdle: async () => {
      const tasks = [...activeByClaim.values()].map((state) => state.task);
      await Promise.allSettled(tasks);
    },
    dispose: () => {
      disposed = true;
      options.abortSignal?.removeEventListener("abort", abortActiveClaims);
      abortActiveClaims();
      // Snapshot: removeActive mutates activeByClaim during this sweep.
      const activeStates = Array.from(activeByClaim.values());
      for (const state of activeStates) {
        removeActive(state);
      }
    },
  };
}
