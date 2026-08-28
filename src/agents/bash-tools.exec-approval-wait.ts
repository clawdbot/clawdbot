import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveApprovalCommandAuthorization } from "../infra/channel-approval-auth.js";
import {
  isInternalMessageChannel,
  isNativeApprovalChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export function shouldAwaitExecApprovalInline(params: {
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
  turnSourceSenderId?: string;
  approvalFollowupMode?: "agent" | "direct";
  trigger?: string;
  config?: OpenClawConfig;
}): boolean {
  if (params.approvalFollowupMode !== undefined) {
    return false;
  }
  // Scheduled runs cannot recover from an "approval-pending" handoff: the
  // isolated session ends and authority-close cancels the parked approval
  // seconds later. Wait inline so a connected approval client gets the full
  // approval window; allow-always there mints the standing grant and this
  // occurrence executes. Cron jobs are single-flight, so waiting cannot
  // stack runs.
  if (params.trigger === "cron") {
    return true;
  }
  // Keep interactive operators inline, but let other senders finish their turn
  // through the existing pending result and approval follow-up path.
  const channel = normalizeMessageChannel(params.turnSourceChannel);
  if (!isNativeApprovalChannel(channel)) {
    return false;
  }
  if (isInternalMessageChannel(channel)) {
    return true;
  }
  if (!params.turnSourceSenderId || !params.config) {
    return false;
  }
  return resolveApprovalCommandAuthorization({
    cfg: params.config,
    channel,
    accountId: params.turnSourceAccountId,
    senderId: params.turnSourceSenderId,
    kind: "exec",
  }).authorized;
}
