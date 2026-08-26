// Feishu plugin module gates sequential queue lanes on turn adoption.
//
// The per-chat sequential queue used to serialize full agent turns: message 2's
// turn was never submitted until message 1's run completed, so core's queue
// policy (steer/collect/followup) always saw isActive=false (#54409). Releasing
// the lane when the turn is ADOPTED (run start) instead lets during-run
// messages reach the gateway while the first turn continues in the background
// — the same pattern telegram already uses. The full turn keeps running under
// core's reply-run registry; this helper only picks the lane-release moment.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

/** Gate outcome: "released" for every non-failure release (adoption success,
 * deferral, abandon, an abort whose abandonment settled); "failed" when a
 * durable terminal transition (adoption, or a pre-adoption abort's
 * abandonment) rejected. The failure is carried separately from the value so
 * even a falsy rejection (`throw undefined`) cannot be conflated with a
 * success release — that would let the flush's race settle on the lane and
 * skip its abandon-and-retry path. */
type FeishuTurnAdoptionGateRelease = { kind: "released" } | { kind: "failed"; failure: unknown };

type FeishuTurnAdoptionGate = {
  /** Wrapped lifecycle to hand to the turn runner, or undefined passthrough. */
  lifecycle: FeishuIngressLifecycle | undefined;
  /**
   * Resolves when the turn is adopted (or otherwise terminal) as
   * `{ kind: "released" }`, or `{ kind: "failed", failure }` when the
   * durable adoption rejected. A gate that never resolves when no lifecycle
   * is given lets the caller's race degrade to the turn-settled leg —
   * today's full-turn wait.
   */
  gate: Promise<FeishuTurnAdoptionGateRelease>;
};

const NEVER_RESOLVING_GATE = new Promise<FeishuTurnAdoptionGateRelease>(() => {});

function createTurnAdoptionGate(
  lifecycle: FeishuIngressLifecycle | undefined,
): FeishuTurnAdoptionGate {
  if (!lifecycle) {
    return { lifecycle: undefined, gate: NEVER_RESOLVING_GATE };
  }
  let released = false;
  let resolveGate!: (release: FeishuTurnAdoptionGateRelease) => void;
  const gate = new Promise<FeishuTurnAdoptionGateRelease>((resolve) => {
    resolveGate = resolve;
  });
  // A pre-adoption abort must abandon the durable claim before the lane
  // frees: releasing "released" here would let the flush win on the lane and
  // settle() adopt the row — a message that a shutdown stopped before
  // reply-lane adoption would be tombstoned, not retried. The original
  // lifecycle's onAbandoned sets handedOff synchronously, so on success the
  // flush's settle() stays a no-op; a failed abandonment carries the gate's
  // failed outcome so the flush catch retries it and surfaces the error.
  const onAbort = () => {
    void (async () => {
      try {
        await lifecycle.onAbandoned();
        releaseAndDetach({ kind: "released" });
      } catch (failure) {
        releaseAndDetach({ kind: "failed", failure });
      }
    })();
  };
  // One function is both the abort listener's target and the release helper;
  // the listener is detached on release so an aborted lifecycle cannot
  // re-enter.
  const releaseAndDetach = (release: FeishuTurnAdoptionGateRelease) => {
    lifecycle.abortSignal.removeEventListener("abort", onAbort);
    if (released) {
      return;
    }
    released = true;
    resolveGate(release);
  };
  if (lifecycle.abortSignal.aborted) {
    releaseAndDetach({ kind: "released" });
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
        releaseAndDetach({ kind: "released" });
      } catch (error) {
        // A failed durable adoption must reject the lane, not release it as
        // success: the flush's race would settle on the lane and skip its
        // abandon-and-retry path (catch → onAbandoned → rethrow → onError).
        releaseAndDetach({ kind: "failed", failure: error });
        throw error;
      }
    },
    // Followup/collect/steer-parked turns signal deferral at enqueue time;
    // release then (preserving the accepted flag) to keep queued messages on
    // today's lane-release timing and preserve collect batching.
    onDeferred: () => {
      const accepted = lifecycle.onDeferred();
      releaseAndDetach({ kind: "released" });
      return accepted;
    },
    onAbandoned: async () => {
      try {
        await lifecycle.onAbandoned();
      } finally {
        releaseAndDetach({ kind: "released" });
      }
    },
  };
  if (lifecycle.onFailed) {
    wrapped.onFailed = async (error: unknown) => {
      try {
        await lifecycle.onFailed?.(error);
      } finally {
        releaseAndDetach({ kind: "released" });
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
      // The turn never ran. The flush observes outcomes through `turn`, so an
      // abandonment persistence failure must reject the turn (and the lane) —
      // settling the capture first would let the flush's race resolve on the
      // turn leg and swallow the failure in the lane.
      const abandoned = gatedLifecycle.onAbandoned();
      settleTurnCapture(Promise.resolve(abandoned));
      await abandoned;
      return;
    }
    // The async wrapper turns a synchronous runTurn throw into a rejection
    // without wrapping the value, matching a plain Promise.reject.
    settleTurnCapture((async () => runTurn(gatedLifecycle))());
    // Release the lane at adoption; the turn's catch leg covers pre-adoption
    // failures (the flush observes them through `turn`). A failed durable
    // adoption arrives through the gate's carried outcome and rejects the
    // lane so the flush's catch → onAbandoned → rethrow → onError path still
    // runs. The queue's eviction bound still applies because the task itself
    // stays pending while the turn runs.
    const outcome = await Promise.race([gate, turn.catch(() => undefined)]);
    if (outcome?.kind === "failed") {
      // A durable-adoption rejection may be a non-Error value — even falsy
      // (`throw undefined`); normalize so the flush's catch observes an Error.
      throw toErrorObject(outcome.failure, "Feishu turn adoption failed");
    }
  };
  const lane = enqueue(sequentialKey, task);
  const turn = turnCapture.then((captured) => captured);
  return { lane, turn };
}
