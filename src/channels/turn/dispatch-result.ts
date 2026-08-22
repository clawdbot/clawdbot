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
type FinalDeliverySignals = Pick<
  ChannelTurnVisibleDeliverySignals,
  "fallbackDelivered" | "deliverySummaryDelivered"
>;

const hasFinalSignal = (signals: FinalDeliverySignals) =>
  signals.fallbackDelivered === true || signals.deliverySummaryDelivered === true;

const hasVisibleSignal = (
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals,
) =>
  result?.observedReplyDelivery === true ||
  signals.observedReplyDelivery === true ||
  hasFinalSignal(signals);

/** Zero-filled reply dispatch count map used before merging optional provider counts. */
export const EMPTY_CHANNEL_TURN_DISPATCH_COUNTS: Record<ReplyDispatchKind, number> = {
  tool: 0,
  block: 0,
  final: 0,
};

/** Returns whether a turn produced any visible reply delivery signal. */
export function hasVisibleChannelTurnDispatchFromReceipt(
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals = {},
): boolean {
  return result?.settledReceipt?.anyVisibleDelivered === true || hasVisibleSignal(result, signals);
}

export function resolveChannelTurnDispatchCounts(result: ChannelTurnDispatchResultLike) {
  const counts = result?.settledReceipt?.counts;
  return counts
    ? {
        tool: counts.tool?.delivered ?? 0,
        block: counts.block?.delivered ?? 0,
        final: counts.final?.delivered ?? 0,
      }
    : { ...EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, ...result?.counts };
}

export function hasVisibleChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals = {},
): boolean {
  if (result?.settledReceipt) {
    return hasVisibleChannelTurnDispatchFromReceipt(result, signals);
  }
  return (
    hasVisibleSignal(result, signals) ||
    result?.queuedFinal === true ||
    Object.values(resolveChannelTurnDispatchCounts(result)).some((count) => count > 0)
  );
}

export function hasFinalChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: FinalDeliverySignals = {},
): boolean {
  const finalCounts = result?.settledReceipt?.counts.final;
  return (
    hasFinalSignal(signals) ||
    (result?.settledReceipt
      ? (finalCounts?.delivered ?? 0) > 0 || (finalCounts?.failedAfterSend ?? 0) > 0
      : result?.queuedFinal === true || resolveChannelTurnDispatchCounts(result).final > 0)
  );
}
