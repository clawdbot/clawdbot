import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";

/** Minimal dispatch result shape needed to count visible channel deliveries. */
export type ChannelTurnDispatchResultLike =
  | {
      queuedFinal?: boolean;
      counts?: Partial<Record<ReplyDispatchKind, number>>;
      observedReplyDelivery?: boolean;
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
  return {
    ...EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
    ...result?.counts,
  };
}

/** Returns whether a turn produced any visible reply delivery signal. */
export function hasVisibleChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals = {},
): boolean {
  const counts = resolveChannelTurnDispatchCounts(result);
  // Non-count signals cover delivery paths that bypass the buffered reply dispatcher.
  return (
    result?.observedReplyDelivery === true ||
    signals.observedReplyDelivery === true ||
    signals.fallbackDelivered === true ||
    signals.deliverySummaryDelivered === true ||
    result?.queuedFinal === true ||
    counts.tool > 0 ||
    counts.block > 0 ||
    counts.final > 0
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
  const counts = resolveChannelTurnDispatchCounts(result);
  return (
    signals.fallbackDelivered === true ||
    signals.deliverySummaryDelivered === true ||
    result?.queuedFinal === true ||
    counts.final > 0
  );
}
