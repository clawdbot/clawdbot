// Slack plugin module implements approval auth behavior.
import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSlackAccount, resolveSlackAccountAllowFrom } from "./accounts.js";
import { normalizeSlackApproverId } from "./exec-approvals.js";

export function getSlackApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveSlackAccount(params).config;
  return resolveApprovalApprovers({
    allowFrom: resolveSlackAccountAllowFrom(params),
    defaultTo: account.defaultTo,
    normalizeApprover: normalizeSlackApproverId,
    normalizeDefaultTo: normalizeSlackApproverId,
  });
}

export function isSlackApprovalAuthorizedSender(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId ? normalizeSlackApproverId(params.senderId) : undefined;
  if (!senderId) {
    return false;
  }
  const approvers = getSlackApprovalApprovers(params);
  if (approvers.length > 0) {
    return approvers.includes(senderId);
  }
  return (resolveSlackAccountAllowFrom(params) ?? []).some((entry) => entry.trim() === "*");
}

export const slackApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Slack",
  resolveApprovers: ({ cfg, accountId }) => getSlackApprovalApprovers({ cfg, accountId }),
  normalizeSenderId: (value) => normalizeSlackApproverId(value),
});
