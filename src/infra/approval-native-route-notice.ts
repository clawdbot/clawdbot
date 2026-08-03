// Formats native-route approval notices shown when command approvals leave the current channel.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { formatHumanList } from "../shared/human-list.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";

/** Formats the human destination label for where native approval prompts were delivered. */
export function describeApprovalDeliveryDestination(params: {
  channelLabel: string;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
}): string {
  const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
  return surfaces.size === 1 && surfaces.has("approver-dm")
    ? `${params.channelLabel} DMs`
    : params.channelLabel;
}

/** Builds the notice shown in the current chat when approval was routed elsewhere. */
export function resolveApprovalRoutedElsewhereNoticeText(
  destinations: readonly string[],
): string | null {
  const uniqueDestinations = sortUniqueStrings(destinations.map((value) => value.trim())).filter(
    Boolean,
  );
  if (uniqueDestinations.length === 0) {
    return null;
  }
  return `Approval required. I sent the approval request to ${formatHumanList(
    uniqueDestinations,
  )}, not this chat.`;
}

/** Builds the fallback slash-command notice when native approval delivery fails. */
export function resolveApprovalDeliveryFailedNoticeText(params: {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions?: readonly string[];
}): string {
  const commandId =
    params.approvalKind === "exec" && params.approvalId.length > 8
      ? params.approvalId.slice(0, 8)
      : params.approvalId;
  // Exec approval ids are long command ids in chat UX; plugin ids can be short
  // semantic ids, so only shorten exec ids and keep the full-id fallback visible.
  const decisions = (
    params.allowedDecisions?.length
      ? params.allowedDecisions
      : ["allow-once", "allow-always", "deny"]
  ).join("|");
  return [
    "Approval required. I could not deliver the native approval request.",
    `Reply with: /approve ${commandId} ${decisions}`,
    "If the short code is ambiguous, use the full id in /approve.",
  ].join("\n");
}
