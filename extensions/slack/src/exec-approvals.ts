// Slack plugin module implements exec approvals behavior.
import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalTargetRecipient,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { doesApprovalRequestMatchChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeStringifiedOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "./accounts.js";

function normalizeSlackUserLikeId(value: string): string | undefined {
  const upper = value.toUpperCase();
  return /^[UW][A-Z0-9]+$/.test(upper) ? upper : undefined;
}

export function normalizeSlackApproverId(value: string | number): string | undefined {
  const trimmed = normalizeStringifiedOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const prefixed = trimmed.match(/^(?:slack|user):([A-Z0-9]+)$/i);
  if (prefixed?.[1]) {
    return normalizeSlackUserLikeId(prefixed[1]);
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention?.[1]) {
    return normalizeSlackUserLikeId(mention[1]);
  }
  return normalizeSlackUserLikeId(trimmed);
}

function resolveSlackOwnerApprovers(cfg: OpenClawConfig): string[] {
  const ownerAllowFrom = cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(ownerAllowFrom) || ownerAllowFrom.length === 0) {
    return [];
  }
  return resolveApprovalApprovers({
    explicit: ownerAllowFrom,
    normalizeApprover: normalizeSlackApproverId,
  });
}
export function getSlackExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveSlackAccount(params).config;
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers ?? resolveSlackOwnerApprovers(params.cfg),
    normalizeApprover: normalizeSlackApproverId,
  });
}

function isSlackExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "slack",
    normalizeSenderId: normalizeSlackApproverId,
    matchTarget: ({ target, normalizedSenderId }) =>
      normalizeSlackApproverId(target.to) === normalizedSenderId,
  });
}

const slackExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: (params) => resolveSlackAccount(params).config.execApprovals,
  resolveApprovers: getSlackExecApprovalApprovers,
  normalizeSenderId: normalizeSlackApproverId,
  isTargetRecipient: isSlackExecApprovalTargetRecipient,
  matchesRequestAccount: (params) =>
    doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "slack",
      accountId: params.accountId,
    }),
});

export const isSlackExecApprovalClientEnabled = slackExecApprovalProfile.isClientEnabled;
export const isSlackExecApprovalAuthorizedSender = slackExecApprovalProfile.isAuthorizedSender;
export const resolveSlackExecApprovalTarget = slackExecApprovalProfile.resolveTarget;
export const shouldSuppressLocalSlackExecApprovalPrompt =
  slackExecApprovalProfile.shouldSuppressLocalPrompt;
