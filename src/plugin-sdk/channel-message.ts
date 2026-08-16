/**
 * @deprecated Use `openclaw/plugin-sdk/channel-outbound` for outbound/message
 * lifecycle helpers and `openclaw/plugin-sdk/channel-inbound` for inbound
 * reply dispatch helpers.
 */
import {
  EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  hasFinalChannelTurnDispatchFromReceipt as hasFinalFromReceipt,
  hasVisibleChannelTurnDispatchFromReceipt as hasVisibleFromReceipt,
  resolveChannelTurnDispatchCountsFromReceipt as resolveCountsFromReceipt,
  type ChannelTurnDispatchResultLike,
  type ChannelTurnVisibleDeliverySignals,
} from "../channels/turn/dispatch-result.js";

export * from "./channel-outbound.js";

// @deprecated Remove these count-shaped projections with this facade after 2026-09-01.
// Canonical channel-inbound helpers consume settled receipts directly.
function withLegacyReceipt(result: ChannelTurnDispatchResultLike) {
  if (!result || result.settledReceipt) {
    return result;
  }
  const counts = { ...EMPTY_CHANNEL_TURN_DISPATCH_COUNTS, ...result.counts };
  const settledCount = (delivered: number) => ({ delivered, failedAfterSend: 0 });
  return {
    ...result,
    settledReceipt: {
      anyVisibleDelivered:
        result.queuedFinal === true || Object.values(counts).some((count) => count > 0),
      counts: {
        tool: settledCount(counts.tool),
        block: settledCount(counts.block),
        final: settledCount(counts.final),
      },
    },
  };
}

/** @deprecated Use `hasFinalInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export function hasFinalChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals = {},
): boolean {
  return result?.queuedFinal === true || hasFinalFromReceipt(withLegacyReceipt(result), signals);
}

/** @deprecated Use `hasVisibleInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export function hasVisibleChannelTurnDispatch(
  result: ChannelTurnDispatchResultLike,
  signals: ChannelTurnVisibleDeliverySignals = {},
): boolean {
  return hasVisibleFromReceipt(withLegacyReceipt(result), signals);
}

/** @deprecated Use `resolveInboundReplyDispatchCounts(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export function resolveChannelTurnDispatchCounts(result: ChannelTurnDispatchResultLike) {
  if (result?.settledReceipt) {
    return resolveCountsFromReceipt(result);
  }
  return {
    ...EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
    ...result?.counts,
  };
}
