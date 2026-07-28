/**
 * Core-owned durable channel-ingress drain.
 *
 * Owns claim recovery, per-lane serialization, adoption-time complete, retry /
 * dead-letter disposition, pre-adoption stall watchdog, and optional supersede.
 */
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import {
  createIngressDrainOwnerId,
  deregisterLiveIngressDrainInstance,
  INGRESS_CLAIM_LEASE_MS,
  isIngressClaimOwnedByOtherLiveProcess,
  isIngressCorruptClaimOwnedByOtherLiveProcess,
  isLiveLocalIngressDrainOwner,
  registerLiveIngressDrainInstance,
} from "./ingress-claim-owner.js";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.js";
import {
  DEFAULT_INGRESS_RETRY_BASE_MS,
  DEFAULT_INGRESS_RETRY_MAX_MS,
  resolveIngressFailureDisposition,
  resolveIngressRetryDelayMs,
  sleepIngressRetryDelay,
  type IngressNonRetryableFailure,
  type IngressRetryPolicyConfig,
} from "./ingress-retry-policy.js";

/** Default claim→adoption stall before dead-lettering with handler-timeout. */
export const DEFAULT_INGRESS_ADOPTION_STALL_MS = 5 * 60 * 1000;

/** Bounded tombstone write retries — wedged ownership beats silent double-dispatch. */
const INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS = 8;

/**
 * Closed error when adoption races a pre-adoption guillotine/supersede, or when
 * a claim-token fence rejects complete/fail (lease reclaimed by another owner).
 * Callers must stop the turn (abortSignal is also aborted when applicable).
 */
class IngressAdoptionLostError extends Error {
  readonly code: "guillotined" | "superseded" | "reclaimed";

  constructor(code: "guillotined" | "superseded" | "reclaimed") {
    super(`ingress adoption lost: ${code}`);
    this.name = "IngressAdoptionLostError";
    this.code = code;
  }
}

export function isIngressAdoptionLostError(error: unknown): error is IngressAdoptionLostError {
  return error instanceof IngressAdoptionLostError;
}

/** Full pre-adoption → adoption ownership lifecycle for one claimed event. */
type ChannelIngressDispatchLifecycle = {
  /** Pre-adoption only. After adopt the drain treats this signal as inert. */
  abortSignal: AbortSignal;
  /**
   * Fires when recovery-relevant session/run state is durable.
   * Drain completes (tombstones) the claim here — never at settle.
   */
  onAdopted: () => void | Promise<void>;
  /**
   * Turn ownership deferred to reply-lane admission (queued followup).
   * Claim remains held until adopted or abandoned.
   */
  onDeferred: () => void;
  /**
   * Durable adoption finalization is in progress (e.g. settlement hold while
   * committing dedupe). Clears the pre-adoption stall watchdog so a timeout
   * settlement cannot race and dead-letter an about-to-complete claim.
   * Claim stays held until onAdopted / onAbandoned / fail.
   */
  onAdoptionFinalizing: () => void;
  /**
   * Deferred turn finished without ever owning the reply lane.
   * Drain releases the claim for retry.
   */
  onAbandoned: () => void | Promise<void>;
};

type ChannelIngressDrainDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

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
  ownerId?: string;
  adoptionStallTimeoutMs?: number;
  claimLeaseMs?: number;
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

type ActiveHandlerState<TPayload, TMetadata> = {
  eventId: string;
  laneKey: string;
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
  abortController: AbortController;
  startedAt: number;
  phase: "dispatching" | "deferred" | "adopted" | "settled";
  task: Promise<void>;
  stallTimer?: ReturnType<typeof setTimeout>;
  claimRefreshTimer?: ReturnType<typeof setInterval>;
  /** Closed code: pre-adoption stall watchdog has claimed settle ownership. */
  guillotined: boolean;
  /** Closed code: pre-adoption supersede has claimed settle ownership. */
  superseded: boolean;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
};

function resolveLaneKey<TPayload, TMetadata>(
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined,
): string {
  return deriveLaneKey?.(record) ?? record.laneKey ?? record.id;
}

function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Maps a drain lifecycle onto reply options.
 * Single surface: turnAdoptionLifecycle only.
 * Marks exclusive admission so collect isolation is not inferred from onAbandoned.
 */
export function bindIngressLifecycleToReplyOptions(lifecycle: ChannelIngressDispatchLifecycle): {
  turnAdoptionLifecycle: {
    admission: "exclusive";
    onAdopted: () => void | Promise<void>;
    onDeferred: () => void;
    onAbandoned: () => void | Promise<void>;
    abortSignal: AbortSignal;
  };
} {
  return {
    turnAdoptionLifecycle: {
      admission: "exclusive",
      onAdopted: lifecycle.onAdopted,
      onDeferred: lifecycle.onDeferred,
      onAbandoned: lifecycle.onAbandoned,
      abortSignal: lifecycle.abortSignal,
    },
  };
}

// onAdoptionFinalizing stays drain-only (not reply-options); channels call it
// via the spooled-replay ALS lifecycle frame during settlement hold.

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
  const scanLimit = options.scanLimit ?? 100;
  const startLimit = options.startLimit ?? 32;
  const activeByLane = new Map<string, ActiveHandlerState<TPayload, TMetadata>>();
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
    const reason = toErrorObject(options.abortSignal?.reason, "ingress-drain-aborted");
    for (const state of activeByLane.values()) {
      if (state.phase === "dispatching" || state.phase === "deferred") {
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
    if (activeByLane.get(state.laneKey) === state) {
      activeByLane.delete(state.laneKey);
    }
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

  /**
   * Claim-token fenced writes can throw OR return false when the lease was
   * reclaimed. For complete, false is ownership loss (do not settle success).
   * For release/fail, false means the row is already gone from this owner —
   * treat as done so abandon races do not wedge.
   */
  const isStopped = () => disposed || options.abortSignal?.aborted === true;

  const commitClaimWriteWithRetry = async (params: {
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
    label: "tombstone" | "dead-letter" | "release";
    write: () => Promise<boolean>;
    falseMeansReclaimed: boolean;
  }): Promise<void> => {
    let attempt = 0;
    for (;;) {
      // First write still runs after session abort: terminal complete/release
      // (failed-retryable requeue, post-dispatch tombstone) must not be blocked.
      // Stop only cuts retry backoffs (webhook stop / dispose mid-retry).
      if (attempt > 0 && isStopped()) {
        throw new Error("ingress drain stopped during claim write");
      }
      try {
        const committed = await params.write();
        if (!committed) {
          if (params.falseMeansReclaimed) {
            throw new IngressAdoptionLostError("reclaimed");
          }
          return;
        }
        return;
      } catch (err) {
        if (isIngressAdoptionLostError(err)) {
          throw err;
        }
        attempt += 1;
        if (isStopped() || attempt >= INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS) {
          if (attempt >= INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS && !isStopped()) {
            log(
              `ingress drain: ${params.label} write failed for event ${params.claim.id} after ${attempt} attempt(s); holding claim: ${formatError(err)}`,
            );
          }
          throw err;
        }
        const delayMs = Math.min(
          DEFAULT_INGRESS_RETRY_MAX_MS,
          DEFAULT_INGRESS_RETRY_BASE_MS * 2 ** (attempt - 1),
        );
        const displayId = params.claim.id.replace(/^0+(?=\d)/, "") || params.claim.id;
        // Operator + test-visible: tombstone/complete retries after durable adoption.
        log(
          `ingress drain: ${params.label} retry ${attempt}/${INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS} for event ${params.claim.id} in ${delayMs}ms: ${formatError(err)}`,
        );
        if (params.label === "tombstone") {
          log(`completion retry ${attempt} scheduled for event ${displayId}`);
        }
        // Abortable sleep: webhook stop aborts options.abortSignal mid-backoff.
        await sleepIngressRetryDelay(delayMs, options.abortSignal);
      }
    }
  };

  const completeClaimWithRetry = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
  ): Promise<void> => {
    // Tombstone via complete() — never delete. Retry IO failures; false = reclaimed.
    await commitClaimWriteWithRetry({
      claim,
      label: "tombstone",
      write: () => queue.complete(claim),
      falseMeansReclaimed: true,
    });
  };

  const releaseClaim = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    lastError?: string,
  ) => {
    await commitClaimWriteWithRetry({
      claim,
      label: "release",
      write: () =>
        queue.release(claim, lastError === undefined ? {} : { lastError, releasedAt: now() }),
      falseMeansReclaimed: false,
    });
  };

  const failClaim = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    reason: string,
    message: string,
  ) => {
    await commitClaimWriteWithRetry({
      claim,
      label: "dead-letter",
      write: () => queue.fail(claim, { reason, message, failedAt: now() }),
      // Fail false after guillotine/supersede race: treat as already settled.
      falseMeansReclaimed: false,
    });
  };

  const applyFailureDisposition = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    err: unknown,
  ) => {
    const disposition = resolveIngressFailureDisposition({
      err,
      event: claim,
      formatError,
      resolveNonRetryableFailure: options.resolveNonRetryableFailure,
      config: options.retryPolicy,
      now: now(),
    });
    if (disposition.kind === "fail") {
      // Operator-visible dead-letter line. Prefer numeric id when the event id
      // is a zero-padded telegram update_id so logs stay human-readable.
      const displayId = claim.id.replace(/^0+(?=\d)/, "") || claim.id;
      log(
        `spooled update ${displayId} failed with non-retryable ${disposition.reason}: ${disposition.message}; dead-lettered`,
      );
      if (disposition.reason === "retry-limit-exceeded") {
        log(
          `spooled update ${displayId} on lane ${claim.laneKey ?? displayId} reached retry limit after ${disposition.attempt} attempts; dead-lettered`,
        );
      }
      await failClaim(claim, disposition.reason, disposition.message);
      return;
    }
    const displayId = claim.id.replace(/^0+(?=\d)/, "") || claim.id;
    log(`spooled update ${displayId} failed; keeping for retry: ${disposition.message}`);
    await releaseClaim(claim, disposition.message);
  };

  const createSettleOwner = (
    state: ActiveHandlerState<TPayload, TMetadata>,
  ): ((fn: () => Promise<void>) => Promise<void>) => {
    let settlePromise: Promise<void> | undefined;
    let settled = false;
    return async (fn) => {
      if (settled) {
        return;
      }
      if (settlePromise) {
        await settlePromise;
        return;
      }
      settlePromise = (async () => {
        // Only mark settled after the tombstone/fail/release write commits.
        // Write failure must keep heartbeat + in-memory ownership (wedged > duplicated).
        await fn();
        settled = true;
        state.phase = "settled";
        removeActive(state);
      })();
      try {
        await settlePromise;
      } catch (err) {
        settlePromise = undefined;
        throw err;
      }
    };
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
      const message = `Channel ingress claim→adoption stalled for event ${displayId} on lane ${state.laneKey} after ${ageMs}ms; marking failed (handler-timeout).`;
      // Closed guillotine flag — catch must not string-sniff errors.
      state.guillotined = true;
      clearStallTimer(state);
      log(message);
      try {
        state.abortController.abort(new Error(message));
      } catch {
        // AbortController.abort is not fallible in practice.
      }
      // Same bounded-retry/hold-ownership policy as tombstone: a fail write
      // error must not falsely settle (would stop heartbeat and wedge recovery).
      void state
        .settleOnce(async () => {
          await failClaim(state.claim, "handler-timeout", message);
        })
        .catch((err: unknown) => {
          log(
            `ingress drain: failed to dead-letter stalled event ${displayId}; holding claim: ${formatError(err)}`,
          );
        });
    }, adoptionStallTimeoutMs);
    state.stallTimer.unref?.();
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
      onAbandoned: async () => {
        if (state.phase !== "deferred" && state.phase !== "dispatching") {
          return;
        }
        if (state.guillotined || state.superseded) {
          return;
        }
        clearStallTimer(state);
        await state
          .settleOnce(async () => {
            await releaseClaim(state.claim, "turn-abandoned");
          })
          .catch(() => undefined);
      },
    };
  };

  const supersedeActiveIfNeeded = async (
    candidate: ChannelIngressQueueRecord<TPayload, TMetadata>,
    laneKey: string,
  ): Promise<boolean> => {
    const pending = activeByLane.get(laneKey);
    if (!pending || pending.phase === "adopted" || pending.phase === "settled") {
      return false;
    }
    if (!(await options.shouldSupersedePending?.(candidate, pending.claim))) {
      return false;
    }
    // Revalidate after async predicate: a late true must not kill an adopted turn
    // or a different map entry that replaced this pending handler.
    const stillPending = activeByLane.get(laneKey);
    if (
      stillPending !== pending ||
      stillPending.phase === "adopted" ||
      stillPending.phase === "settled" ||
      stillPending.guillotined ||
      stillPending.superseded
    ) {
      return false;
    }
    // Pre-adoption supersede only — after adoption core owns interruption.
    // Tombstone (complete), never release: requeue would replay the aborted turn.
    stillPending.superseded = true;
    clearStallTimer(stillPending);
    try {
      stillPending.abortController.abort(new Error("ingress-superseded"));
    } catch {
      // ignore
    }
    try {
      await stillPending.settleOnce(async () => {
        await completeClaimWithRetry(stillPending.claim);
      });
    } catch (err) {
      log(
        `ingress drain: failed to tombstone superseded event ${stillPending.eventId}: ${formatError(err)}`,
      );
    }
    return true;
  };

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
      guillotined: false,
      superseded: false,
      task: Promise.resolve(),
      settleOnce: async () => {},
    } as ActiveHandlerState<TPayload, TMetadata>;
    state.settleOnce = createSettleOwner(state);
    const lifecycle = createLifecycle(state);
    armStallWatchdog(state);
    armClaimRefresh(state);

    state.task = (async () => {
      try {
        const result = await options.dispatchClaimedEvent(claim, lifecycle);
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
        if (disposed) {
          return;
        }
        if (options.abortSignal?.aborted) {
          return;
        }
        if (state.phase === "settled") {
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
      }
    })();

    activeByLane.set(laneKey, state);
    return state;
  };

  const recoverStaleClaims = async (): Promise<number> => {
    const activeLanes = new Set(activeByLane.keys());
    return await queue.recoverStaleClaims({
      staleMs: 0,
      now: now(),
      shouldRecover: (claim) => {
        const laneKey = resolveLaneKey(claim, options.deriveLaneKey);
        if (activeLanes.has(laneKey)) {
          return false;
        }
        if (activeByLane.has(laneKey)) {
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
    const activeLaneKeys = new Set(
      [...activeByLane.values()]
        .filter((state) => state.phase !== "settled")
        .map((state) => state.laneKey),
    );
    const claimedLaneKeys = new Set(
      claims.map((claim) => resolveLaneKey(claim, options.deriveLaneKey)),
    );
    const retryDelayedLaneKeys = new Set<string>();
    for (const event of pending) {
      if (resolveIngressRetryDelayMs(event, options.retryPolicy, now()) > 0) {
        retryDelayedLaneKeys.add(resolveLaneKey(event, options.deriveLaneKey));
      }
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
      const laneKey = resolveLaneKey(event, options.deriveLaneKey);
      if (await supersedeActiveIfNeeded(event, laneKey)) {
        blockedLaneKeys.delete(laneKey);
      }
    }

    const candidateIds = pending.map((event) => event.id);
    let started = 0;
    while (started < startLimit) {
      if (shouldStop()) {
        break;
      }
      const claimed = await queue.claimNext({
        ownerId,
        blockedLaneKeys,
        orderBy,
        scanLimit,
        candidateIds,
        deriveLaneKey: options.deriveLaneKey,
      });
      if (!claimed) {
        break;
      }
      if (shouldStop()) {
        await queue.release(claimed, { recordAttempt: false });
        break;
      }
      const laneKey = resolveLaneKey(claimed, options.deriveLaneKey);
      const existing = activeByLane.get(laneKey);
      if (existing && existing.phase !== "settled") {
        if (await supersedeActiveIfNeeded(claimed, laneKey)) {
          blockedLaneKeys.delete(laneKey);
        }
        if (activeByLane.has(laneKey)) {
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
    activeLaneKeys: () => new Set(activeByLane.keys()),
    waitForIdle: async () => {
      const tasks = [...activeByLane.values()].map((state) => state.task);
      await Promise.allSettled(tasks);
    },
    dispose: () => {
      disposed = true;
      options.abortSignal?.removeEventListener("abort", abortActiveClaims);
      deregisterLiveIngressDrainInstance(ownerId);
      // Snapshot: removeActive mutates activeByLane during this sweep.
      const activeStates = Array.from(activeByLane.values());
      for (const state of activeStates) {
        clearStallTimer(state);
        if (state.phase === "dispatching" || state.phase === "deferred") {
          try {
            state.abortController.abort(new Error("ingress-drain-disposed"));
          } catch {
            // ignore
          }
        }
        removeActive(state);
      }
    },
  };
}
