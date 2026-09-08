// Per-dispatch settled-delivery ledger (#114768). Answers "did this turn produce
// a visible message" from transport settlement, not queue/route admission. Every
// dispatcher send in the dispatch pipeline goes through sendQueued and every
// routed transport result is recorded, so no delivery lane can bypass the
// no-visible-reply fallback gate with a fresh inference flag.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../reply-payload.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import {
  ReplyDispatchDeliveryError,
  resolveRoutedReplyDeliveryOutcome,
} from "./reply-dispatch-outcome.js";
import {
  captureReplyDispatchDeliveryOutcome,
  type ReplyDispatchDeliveryOutcome,
  waitForReplyDispatcherIdle,
} from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

// Failsafe for transports that never settle: the completion barrier bounds
// delivery waits at the operation layer, and finalization must not out-wait it.
const SETTLE_QUEUED_TIMEOUT_MS = 30_000;

type LedgerQueuedSend = {
  queued: boolean;
  outcome?: Promise<ReplyDispatchDeliveryOutcome>;
  hasPendingDelivery?: () => boolean;
};

type LedgerSettleResult = "settled" | "aborted" | "timed-out";

type ReplyTurnLedger = {
  /** Enqueue on the dispatcher and record the payload's settled visibility. */
  sendQueued: (kind: ReplyDispatchKind, payload: ReplyPayload) => LedgerQueuedSend;
  /** Record a routed transport result; routed sends settle at their call site. */
  recordRoutedDelivery: (
    payload: ReplyPayload,
    result: Parameters<typeof resolveRoutedReplyDeliveryOutcome>[0],
  ) => void;
  /** Resolve every admitted payload's outcome so the fallback gate decides after
   * beforeDeliver hooks and transport delivery, not at admission. Only a
   * "settled" result proves the visibility verdict is complete. */
  settleQueued: (abortSignal?: AbortSignal) => Promise<LedgerSettleResult>;
  /** Includes uncertain sends, which cannot safely be retried. */
  mayHaveDelivered: () => boolean;
  hasObservedDelivery: () => boolean;
  canAttemptFallback: () => boolean;
  hasPendingDelivery: () => boolean;
};

export async function requireQueuedReplyDelivery(params: {
  delivery: LedgerQueuedSend;
  dispatcher: Pick<ReplyDispatcher, "supportsSettledReceipt" | "waitForIdle">;
  abortSignal: AbortSignal | undefined;
}): Promise<void> {
  if (!params.delivery.queued) {
    throw new Error("queued reply delivery failed");
  }
  const outcome = params.delivery.outcome;
  if (!outcome) {
    const receipt = await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
    if (
      params.dispatcher.supportsSettledReceipt === true &&
      receipt?.anyVisibleDelivered !== true
    ) {
      throw new Error("queued reply delivery failed");
    }
    return;
  }
  const settledOutcome = await runWithDispatchAbortSignal(params.abortSignal, () => outcome);
  if (settledOutcome !== "delivered") {
    throw new ReplyDispatchDeliveryError(settledOutcome);
  }
}

export function createReplyTurnLedger(dispatcher: ReplyDispatcher): ReplyTurnLedger {
  const outcomes = new Set<ReplyDispatchDeliveryOutcome>();
  let pendingDelivery = false;
  const mayHaveDelivered = () => outcomes.has("delivered") || outcomes.has("failed-deliver");
  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload): boolean => {
    if (kind === "tool") {
      return dispatcher.sendToolResult(payload);
    }
    if (kind === "block") {
      return dispatcher.sendBlockReply(payload);
    }
    return dispatcher.sendFinalReply(payload);
  };
  return {
    sendQueued(kind, payload) {
      const capture =
        dispatcher.supportsSettledReceipt === true
          ? captureReplyDispatchDeliveryOutcome(payload)
          : undefined;
      const queued = enqueue(kind, payload);
      if (!queued) {
        return { queued: false };
      }
      if (!capture) {
        // Legacy dispatchers expose admission only. Treat an accepted send as
        // potentially visible so the fallback cannot duplicate its delivery.
        outcomes.add("failed-deliver");
        return { queued: true };
      }
      if (!capture.isTracked()) {
        return { queued: true };
      }
      const outcome = capture.promise.then((settled) => {
        pendingDelivery ||= capture.hasPendingDelivery();
        if (hasOutboundReplyContent(payload, { trimText: true })) {
          outcomes.add(settled);
        }
        return settled;
      });
      return { queued: true, outcome, hasPendingDelivery: capture.hasPendingDelivery };
    },
    recordRoutedDelivery(payload, result) {
      const outcome = resolveRoutedReplyDeliveryOutcome(result);
      pendingDelivery ||=
        result.queueCustody === "held" || result.ambiguous === true || outcome === "recovery-owned";
      if (hasOutboundReplyContent(payload, { trimText: true })) {
        outcomes.add(outcome);
      }
    },
    async settleQueued(abortSignal) {
      if (abortSignal?.aborted) {
        return "aborted";
      }
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, SETTLE_QUEUED_TIMEOUT_MS);
        timer.unref?.();
      });
      let removeAbortListener: (() => void) | undefined;
      const aborted = abortSignal
        ? new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            abortSignal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
          })
        : undefined;
      try {
        const receipt = await Promise.race([
          dispatcher.waitForIdle(),
          deadline,
          ...(aborted ? [aborted] : []),
        ]);
        if (abortSignal?.aborted) {
          return "aborted";
        }
        if (timedOut) {
          return "timed-out";
        }
        if (dispatcher.supportsSettledReceipt === true && receipt) {
          for (const counts of Object.values(receipt.counts)) {
            if (counts.delivered > 0) {
              outcomes.add("delivered");
            }
            if (counts.failedAfterSend > 0) {
              outcomes.add("failed-deliver");
            }
          }
        }
        pendingDelivery ||= receipt?.hasPendingDelivery === true;
        return "settled";
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        removeAbortListener?.();
      }
    },
    mayHaveDelivered,
    hasObservedDelivery: () => outcomes.has("delivered"),
    canAttemptFallback: () =>
      !mayHaveDelivered() && !pendingDelivery && !outcomes.has("recovery-owned"),
    hasPendingDelivery: () => pendingDelivery,
  };
}
