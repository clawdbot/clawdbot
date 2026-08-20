/**
 * Pre-adoption stall watchdog for the channel ingress drain.
 *
 * Extracted from ingress-drain.ts so the stall/cancellation policy has one
 * inspectable home (and so ingress-drain.ts stays under its max-lines budget).
 *
 * Policy, in order:
 *  1. A pre-adoption stall means the event was never handled. Aborting and
 *     immediately dead-lettering destroys an inbound user message whenever the
 *     agent is merely busy for longer than the stall window.
 *  2. AbortSignal is cooperative: abort() returns before the dispatch actually
 *     exits. Releasing the claim at that moment lets the monitor re-claim and
 *     re-dispatch the same event while the original callback can still produce
 *     side effects (duplicate agent work or duplicate replies). So a release is
 *     fenced behind dispatch quiescence.
 *  3. If the dispatch does not quiesce within the fence window, ownership is
 *     HELD rather than released. Wedged-but-owned beats duplicated delivery,
 *     matching the tombstone/fail-write policy elsewhere in this module.
 *  4. Dead-lettering is terminal and cannot be re-dispatched, so it does not
 *     need the fence.
 */
import type { ActiveHandlerState } from "./ingress-drain-state.js";
import type { ChannelIngressQueueClaim } from "./ingress-queue.js";
import {
  shouldDeadLetterRetryableIngressEvent,
  type IngressRetryPolicyConfig,
} from "./ingress-retry-policy.js";

/**
 * Bounded wait for an aborted pre-adoption dispatch to exit before its claim is
 * released for retry. Long enough for a cooperative callback to observe the
 * abort and unwind; short enough that a genuinely wedged dispatch does not stall
 * recovery indefinitely.
 */
const DEFAULT_INGRESS_STALL_QUIESCE_MS = 10_000;

type IngressStallWatchdogDeps<TPayload, TMetadata> = {
  adoptionStallTimeoutMs: number;
  retryPolicy?: IngressRetryPolicyConfig;
  now: () => number;
  log: (message: string) => void;
  formatError: (err: unknown) => string;
  clearStallTimer: (state: ActiveHandlerState<TPayload, TMetadata>) => void;
  failClaim: (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    reason: string,
    message: string,
  ) => Promise<void>;
  releaseClaim: (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    releaseOptions?: { lastError?: string; recordAttempt?: boolean },
  ) => Promise<void>;
};

/**
 * Resolves true when the dispatch task settled within the fence window, false
 * when it is still running. Never rejects: a dispatch that throws has exited,
 * which is exactly the condition the fence is waiting for.
 */
async function waitForDispatchQuiesce(
  task: Promise<unknown> | undefined,
  quiesceMs: number,
): Promise<boolean> {
  if (!task) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), quiesceMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function armIngressStallWatchdog<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
  deps: IngressStallWatchdogDeps<TPayload, TMetadata>,
): void {
  deps.clearStallTimer(state);
  state.stallTimer = setTimeout(() => {
    // Pre-adoption only (dispatching OR deferred). Timer is not cleared by deferral.
    if (state.phase !== "dispatching" && state.phase !== "deferred") {
      return;
    }
    const ageMs = deps.now() - state.startedAt;
    const displayId = state.eventId.replace(/^0+(?=\d)/, "") || state.eventId;
    const stallAttempt = (state.claim.attempts ?? 0) + 1;
    const deadLetter = shouldDeadLetterRetryableIngressEvent(
      state.claim,
      stallAttempt,
      deps.retryPolicy,
      deps.now(),
    );
    // P3: the operator-visible line must name the disposition actually taken,
    // so preservation is distinguishable from terminal loss.
    const disposition = deadLetter
      ? "dead-lettering (handler-timeout; retry budget exhausted)"
      : `releasing for retry (attempt ${stallAttempt}); message preserved`;
    const message =
      `Channel ingress claim\u2192adoption stalled for event ${displayId} ` +
      `on lane ${state.laneKey} after ${ageMs}ms; ${disposition}.`;
    // Closed guillotine flag - catch must not string-sniff errors.
    state.guillotined = true;
    deps.clearStallTimer(state);
    deps.log(message);
    try {
      state.abortController.abort(new Error(message));
    } catch {
      // AbortController.abort is not fallible in practice.
    }

    const settlementTask = (async () => {
      if (deadLetter) {
        // Terminal: the event cannot be re-dispatched, so no fence is needed.
        await state.settleOnce(async () => {
          await deps.failClaim(state.claim, "handler-timeout", message);
        });
        return;
      }
      // Fence the release behind dispatch quiescence so a re-claim cannot run
      // concurrently with an abort-ignoring callback or deferred participant.
      const quiesced = await waitForDispatchQuiesce(
        state.quiescence.task,
        DEFAULT_INGRESS_STALL_QUIESCE_MS,
      );
      if (!quiesced) {
        deps.log(
          `ingress drain: stalled event ${displayId} did not exit within the ` +
            `cancellation fence; holding ownership instead of releasing ` +
            `(duplicate dispatch would be worse than delayed recovery).`,
        );
        // Keep refreshing the claim and finish the original settlement once
        // delayed quiescence arrives. Returning here would wedge the lane even
        // after the callback or deferred participant eventually exits.
        await state.quiescence.task;
        deps.log(
          `ingress drain: stalled event ${displayId} eventually quiesced; ` +
            `releasing the held claim for retry.`,
        );
      }
      await state.settleOnce(async () => {
        try {
          await deps.releaseClaim(state.claim, { lastError: message });
        } catch (err) {
          // A broken release store must not wedge the lane forever: fall back
          // to the terminal dead-letter write so recovery stays guaranteed
          // whenever any disposition path still works.
          deps.log(
            `ingress drain: release for retry failed for stalled event ${displayId}; ` +
              `dead-lettering (handler-timeout) so the lane recovers: ${deps.formatError(err)}`,
          );
          await deps.failClaim(state.claim, "handler-timeout", message);
        }
      });
    })();
    state.stallSettlementTask = settlementTask;
    void settlementTask.catch((err: unknown) => {
      // Terminal write failure: the claim stays held (wedged > lost), but the
      // settlement is no longer pending — clearing it stops the monitor from
      // rearming its idle wake and pumping forever on an unsettleable lane.
      state.stallSettlementTask = undefined;
      deps.log(
        `ingress drain: failed to settle stalled event ${displayId}; ` +
          `holding claim: ${deps.formatError(err)}`,
      );
    });
  }, deps.adoptionStallTimeoutMs);
  state.stallTimer.unref?.();
}
