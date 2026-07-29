// Synology Chat plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveAccount } from "./accounts.js";

function normalizeSynologyChatApproverId(value: string | number): string | undefined {
  const trimmed = String(value).trim();
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

export const synologyChatApprovalAuth = createChannelApprovalAuth({
  channelLabel: "Synology Chat",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveAccount(cfg ?? {}, accountId);
    return { allowFrom: account.allowedUserIds };
  },
  normalizeApprover: normalizeSynologyChatApproverId,
}).approvalAuth;
