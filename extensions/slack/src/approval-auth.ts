// Slack plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveSlackAccount, resolveSlackAccountAllowFrom } from "./accounts.js";
import { normalizeSlackApproverId } from "./exec-approvals.js";

const slackApproval = createChannelApprovalAuth({
  channelLabel: "Slack",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveSlackAccount({ cfg, accountId }).config;
    return {
      allowFrom: resolveSlackAccountAllowFrom({ cfg, accountId }),
      defaultTo: account.defaultTo,
    };
  },
  normalizeApprover: normalizeSlackApproverId,
  normalizeDefaultTo: normalizeSlackApproverId,
  isWildcardAuthorized: ({ purpose, senderId, inputs, approvers }) =>
    purpose === "sender" &&
    Boolean(senderId) &&
    approvers.length === 0 &&
    inputs.allowFrom?.some((entry) => String(entry).trim() === "*") === true,
});

export const getSlackApprovalApprovers = slackApproval.resolveApprovers;
export const isSlackApprovalAuthorizedSender = slackApproval.isAuthorizedSender;
