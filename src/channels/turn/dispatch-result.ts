import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";

export type ChannelTurnDispatchResultLike =
  | {
      queuedFinal?: boolean;
      counts?: Partial<Record<ReplyDispatchKind, number>>;
    }
  | null
  | undefined;

export type ChannelTurnVisibleDeliverySignals = {
  observedReplyDelivery?: boolean;
  fallbackDelivered?: boolean;
  deliverySummaryDelivered?: boolean;
};

export const EMPTY_CHANNEL_TURN_DISPATCH_COUNTS: Record<ReplyDispatchKind, number> = {
  tool: 0,
  block: 0,
  final: 0,
};

export function resolveChannelTurnDispatchCounts(
  result: ChannelTurnDispatchResultLike,
): Record<ReplyDispatchKind, number> {
  return {
    ...EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
    ...result?.counts,
  };
}

export function hasVisibleChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals = {},
): boolean {
  const counts = resolveChannelTurnDispatchCounts(result);
  return (
    signals.observedReplyDelivery === true ||
    signals.fallbackDelivered === true ||
    signals.deliverySummaryDelivered === true ||
    result?.queuedFinal === true ||
    counts.tool > 0 ||
    counts.block > 0 ||
    counts.final > 0
  );
}

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
