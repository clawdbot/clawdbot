// Feishu plugin module gates sequential queue lanes on turn adoption.
//
// The per-chat sequential queue used to serialize full agent turns: message 2's
// turn was never submitted until message 1's run completed, so core's queue
// policy (steer/collect/followup) always saw isActive=false (#54409). Releasing
// the lane when the turn is ADOPTED (run start) instead lets during-run
// messages reach the gateway while the first turn continues in the background
// — the same pattern telegram already uses. The full turn keeps running under
// core's reply-run registry; this helper only picks the lane-release moment.
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

type FeishuTurnAdoptionGate = {
  /** Wrapped lifecycle to hand to the turn runner, or undefined passthrough. */
  lifecycle: FeishuIngressLifecycle | undefined;
  /**
   * Resolves when the turn is adopted (or otherwise terminal). Carries the
   * durable adoption failure when one rejected: releasing a failed adoption
   * as success would let the flush's race settle on the lane and skip its
   * abandon-and-retry path. A gate that never resolves when no lifecycle is
   * given lets the caller's race degrade to the turn-settled leg — today's
   * full-turn wait.
   */
  gate: Promise<unknown>;
};

const NEVER_RESOLVING_GATE = new Promise<unknown>(() => {});

export function createTurnAdoptionGate(
  lifecycle: FeishuIngressLifecycle | undefined,
): FeishuTurnAdoptionGate {
  if (!lifecycle) {
    return { lifecycle: undefined, gate: NEVER_RESOLVING_GATE };
  }
  let released = false;
  let resolveGate!: (failure?: unknown) => void;
  const gate = new Promise<unknown>((resolve) => {
    resolveGate = resolve;
  });
  // The abort listener never forwards its Event argument into the gate: only
  // a failed durable adoption carries a value, and an abort Event is not one.
  const onAbort = () => releaseAndDetach();
  // One function is both the abort listener's target and the release helper;
  // the listener is detached on release so an aborted lifecycle cannot
  // re-enter.
  const releaseAndDetach = (failure?: unknown) => {
    lifecycle.abortSignal.removeEventListener("abort", onAbort);
    if (released) {
      return;
    }
    released = true;
    resolveGate(failure);
  };
  if (lifecycle.abortSignal.aborted) {
    releaseAndDetach();
  } else {
    lifecycle.abortSignal.addEventListener("abort", onAbort, { once: true });
  }
  const wrapped: FeishuIngressLifecycle = {
    ...lifecycle,
    // Release only after the original settles so replay claims are committed
    // and the drain tombstone is durable before the queue lane frees.
    onAdopted: async () => {
      try {
        await lifecycle.onAdopted();
        releaseAndDetach();
      } catch (error) {
        // A failed durable adoption must reject the lane, not release it as
        // success: the flush's race would settle on the lane and skip its
        // abandon-and-retry path (catch → onAbandoned → rethrow → onError).
        releaseAndDetach(error);
        throw error;
      }
    },
    // Followup/collect/steer-parked turns signal deferral at enqueue time;
    // release then (preserving the accepted flag) to keep queued messages on
    // today's lane-release timing and preserve collect batching.
    onDeferred: () => {
      const accepted = lifecycle.onDeferred();
      releaseAndDetach();
      return accepted;
    },
    onAbandoned: async () => {
      try {
        await lifecycle.onAbandoned();
      } finally {
        releaseAndDetach();
      }
    },
  };
  if (lifecycle.onFailed) {
    wrapped.onFailed = async (error: unknown) => {
      try {
        await lifecycle.onFailed?.(error);
      } finally {
        releaseAndDetach();
      }
    };
  }
  return { lifecycle: wrapped, gate };
}

export function enqueueAdoptionGatedTurn(params: {
  enqueue: (key: string, task: () => Promise<void>) => Promise<void>;
  sequentialKey: string;
  lifecycle: FeishuIngressLifecycle | undefined;
  runTurn: (lifecycle: FeishuIngressLifecycle | undefined) => Promise<void>;
}): { lane: Promise<void>; turn: Promise<void> } {
  const { enqueue, sequentialKey, lifecycle, runTurn } = params;
  const { lifecycle: gatedLifecycle, gate } = createTurnAdoptionGate(lifecycle);
  let settleTurnCapture!: (turn: Promise<void>) => void;
  const turnCapture = new Promise<Promise<void>>((resolve) => {
    settleTurnCapture = resolve;
  });
  const task = async () => {
    if (gatedLifecycle?.abortSignal.aborted) {
      // The turn never ran. Settle the capture first so the flush cannot hang
      // if the durable abandon rejects; the lane then carries the rejection.
      settleTurnCapture(Promise.resolve());
      await gatedLifecycle.onAbandoned();
      return;
    }
    // The async wrapper turns a synchronous runTurn throw into a rejection
    // without wrapping the value, matching a plain Promise.reject.
    settleTurnCapture((async () => runTurn(gatedLifecycle))());
    // Release the lane at adoption; the turn's catch leg covers pre-adoption
    // failures (the flush observes them through `turn`). A failed durable
    // adoption arrives through the gate's carried value and rejects the lane
    // so the flush's catch → onAbandoned → rethrow → onError path still runs.
    // The queue's eviction bound still applies because the task itself stays
    // pending while the turn runs.
    const adoptionFailure = await Promise.race([gate, turn.catch(() => undefined)]);
    if (adoptionFailure) {
      throw adoptionFailure;
    }
  };
  const lane = enqueue(sequentialKey, task);
  const turn = turnCapture.then((captured) => captured);
  return { lane, turn };
}
