// Per-dispatch settled-delivery ledger (#114768). Answers "did this turn produce
// a visible message" from transport settlement, not queue/route admission. Every
// dispatcher send in the dispatch pipeline goes through sendQueued and every
// routed transport result is recorded, so no delivery lane can bypass the
// no-visible-reply fallback gate with a fresh inference flag.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../reply-payload.js";
import {
  captureReplyDispatchDeliveryOutcome,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export type LedgerQueuedSend = {
  queued: boolean;
  /** Present only when the core dispatcher exposes this payload's settlement. */
  outcome?: Promise<ReplyDispatchDeliveryOutcome>;
};

export type ReplyTurnLedger = {
  /** Enqueue on the dispatcher and record the payload's settled visibility. */
  sendQueued: (kind: ReplyDispatchKind, payload: ReplyPayload) => LedgerQueuedSend;
  /** Record a routed transport result; routed sends settle at their call site. */
  recordRoutedDelivery: (payload: ReplyPayload, delivered: boolean) => void;
  /** Resolve every admitted payload's outcome so the fallback gate decides after
   * beforeDeliver hooks and transport delivery, not at admission. */
  settleQueued: (abortSignal?: AbortSignal) => Promise<void>;
  /** True once any settled, contentful, non-suppressed delivery exists. */
  hasVisibleDelivery: () => boolean;
  /** True when the dispatcher admitted payloads the dispatch pipeline never sent
   * (channel-owned sends). Their settlement is unknown, so the fallback gate
   * treats them conservatively as visible: silence over a double-send. */
  hasForeignQueuedAdmissions: () => boolean;
};

export function createReplyTurnLedger(dispatcher: ReplyDispatcher): ReplyTurnLedger {
  let visibleDeliveries = 0;
  let queuedAdmissions = 0;
  const pendingOutcomes: Array<Promise<void>> = [];
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
      const capture = captureReplyDispatchDeliveryOutcome(payload);
      const queued = enqueue(kind, payload);
      if (!queued) {
        return { queued: false };
      }
      queuedAdmissions += 1;
      // Contentless payloads (metadata-only, TTS bookkeeping) never prove the
      // user saw anything, even when the transport accepts them.
      const contentful = hasOutboundReplyContent(payload, { trimText: true });
      if (!capture.isTracked()) {
        // Non-core dispatchers expose no settlement; admission stays their
        // strongest visibility fact (legacy trust level).
        if (contentful) {
          visibleDeliveries += 1;
        }
        return { queued: true };
      }
      pendingOutcomes.push(
        capture.promise.then((outcome) => {
          if (contentful && outcome === "delivered") {
            visibleDeliveries += 1;
          }
        }),
      );
      return { queued: true, outcome: capture.promise };
    },
    recordRoutedDelivery(payload, delivered) {
      if (delivered && hasOutboundReplyContent(payload, { trimText: true })) {
        visibleDeliveries += 1;
      }
    },
    async settleQueued(abortSignal) {
      // Outcome promises resolve when the dispatcher send chain settles each
      // payload; the wait is bounded by the per-stage beforeDeliver deadlines and
      // the transport sends the turn's completion barrier already waits for.
      const settled = Promise.all(pendingOutcomes).then(() => undefined);
      if (!abortSignal) {
        await settled;
        return;
      }
      if (abortSignal.aborted) {
        return;
      }
      let removeAbortListener: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        abortSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
      });
      try {
        await Promise.race([settled, aborted]);
      } finally {
        removeAbortListener?.();
      }
    },
    hasVisibleDelivery: () => visibleDeliveries > 0,
    hasForeignQueuedAdmissions: () => {
      const counts = dispatcher.getQueuedCounts();
      return counts.tool + counts.block + counts.final > queuedAdmissions;
    },
  };
}
