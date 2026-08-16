// Dispatch-result helpers for counting visible channel turn deliveries.
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";

/** Minimal dispatch result shape needed to count visible channel deliveries. */
export type ChannelTurnDispatchResultLike =
  | {
      queuedFinal?: boolean;
      counts?: Partial<Record<ReplyDispatchKind, number>>;
      settledReceipt?: {
        anyVisibleDelivered: boolean;
        counts: Partial<Record<ReplyDispatchKind, { delivered: number; failedAfterSend: number }>>;
      };
      observedReplyDelivery?: boolean;
      deferredToActiveRun?: "steer" | "followup";
    }
  | null
  | undefined;

/** Extra delivery signals observed outside the normal dispatch count payload. */
export type ChannelTurnVisibleDeliverySignals = {
  observedReplyDelivery?: boolean;
  fallbackDelivered?: boolean;
  deliverySummaryDelivered?: boolean;
};

/** Zero-filled reply dispatch count map used before merging optional provider counts. */
export const EMPTY_CHANNEL_TURN_DISPATCH_COUNTS: Record<ReplyDispatchKind, number> = {
  tool: 0,
  block: 0,
  final: 0,
};

/** Resolves dispatch counts with missing reply kinds filled as zero. */
export function resolveChannelTurnDispatchCounts(
  result: ChannelTurnDispatchResultLike,
): Record<ReplyDispatchKind, number> {
  const receiptCounts = result?.settledReceipt?.counts;
  return {
    tool: receiptCounts?.tool?.delivered ?? 0,
    block: receiptCounts?.block?.delivered ?? 0,
    final: receiptCounts?.final?.delivered ?? 0,
  };
}

/** Returns whether a turn produced any visible reply delivery signal. */
export function hasVisibleChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals = {},
): boolean {
  return (
    result?.settledReceipt?.anyVisibleDelivered === true ||
    result?.observedReplyDelivery === true ||
    signals.observedReplyDelivery === true ||
    signals.fallbackDelivered === true ||
    signals.deliverySummaryDelivered === true
  );
}

/** Returns whether a turn produced a final reply, fallback, summary, or queued final payload. */
export function hasFinalChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: Pick<
    ChannelTurnVisibleDeliverySignals,
    "fallbackDelivered" | "deliverySummaryDelivered"
  > = {},
): boolean {
  const finalCounts = result?.settledReceipt?.counts.final;
  return (
    signals.fallbackDelivered === true ||
    signals.deliverySummaryDelivered === true ||
    (finalCounts?.delivered ?? 0) > 0 ||
    (finalCounts?.failedAfterSend ?? 0) > 0
  );
}
