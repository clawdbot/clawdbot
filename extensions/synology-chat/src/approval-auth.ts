import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveAccount } from "./accounts.js";

function normalizeSynologyChatApproverId(value: string | number): string | undefined {
  const trimmed = String(value).trim();
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

export const synologyChatApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Synology Chat",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveAccount(cfg ?? {}, accountId);
    return resolveApprovalApprovers({
      allowFrom: account.allowedUserIds,
      normalizeApprover: normalizeSynologyChatApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeSynologyChatApproverId(value),
});
