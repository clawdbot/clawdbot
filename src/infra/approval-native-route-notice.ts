import { formatHumanList } from "../shared/human-list.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";

export function describeApprovalDeliveryDestination(params: {
  channelLabel: string;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
}): string {
  const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
  return surfaces.size === 1 && surfaces.has("approver-dm")
    ? `${params.channelLabel} DMs`
    : params.channelLabel;
}

export function resolveApprovalRoutedElsewhereNoticeText(
  destinations: readonly string[],
): string | null {
  const uniqueDestinations = Array.from(new Set(destinations.map((value) => value.trim()))).filter(
    Boolean,
  );
  if (uniqueDestinations.length === 0) {
    return null;
  }
  return `Approval required. I sent the approval request to ${formatHumanList(
    uniqueDestinations.toSorted((a, b) => a.localeCompare(b)),
  )}, not this chat.`;
}
