// Zalo plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveZaloAccount } from "./accounts.js";

function normalizeZaloApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(zalo|zl):/i, "")
    .trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

export const zaloApprovalAuth = createChannelApprovalAuth({
  channelLabel: "Zalo",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveZaloAccount({ cfg, accountId }).config;
    return { allowFrom: account.allowFrom };
  },
  normalizeApprover: normalizeZaloApproverId,
}).approvalAuth;
