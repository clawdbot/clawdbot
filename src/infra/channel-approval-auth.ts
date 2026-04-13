import { getChannelPlugin, resolveChannelApprovalCapability } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isImplicitSameChatApprovalAuthorization } from "../plugin-sdk/approval-auth-helpers.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export type ApprovalCommandAuthorization = {
  authorized: boolean;
  reason?: string;
  explicit: boolean;
};

export function resolveApprovalCommandAuthorization(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  kind: "exec" | "plugin";
}): ApprovalCommandAuthorization {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return { authorized: true, explicit: false };
  }
  const approvalCapability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  const resolved = approvalCapability?.authorizeActorAction?.({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: params.senderId,
    action: "approve",
    approvalKind: params.kind,
  });
  if (!resolved) {
    return { authorized: true, explicit: false };
  }
  // Keep `resolved` by reference; cloning before this check would drop the
  // non-enumerable implicit-fallback marker.
  const implicitSameChatAuthorization = isImplicitSameChatApprovalAuthorization(resolved);
  const availability = approvalCapability?.getActionAvailabilityState?.({
    cfg: params.cfg,
    accountId: params.accountId,
    action: "approve",
    approvalKind: params.kind,
  });
  return {
    authorized: resolved.authorized,
    reason: resolved.reason,
    explicit: resolved.authorized
      ? !implicitSameChatAuthorization && availability?.kind !== "disabled"
      : true,
  };
}
