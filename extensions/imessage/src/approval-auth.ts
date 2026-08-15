// Imessage plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveIMessageAccount } from "./accounts.js";
import { normalizeIMessageHandle } from "./targets.js";

function normalizeIMessageApproverId(value: string | number): string | undefined {
  const raw = String(value).trim();
  if (!raw) {
    return undefined;
  }
  // Normalize first so service-prefixed direct handles (`imessage:+...`,
  // `sms:+...`, `auto:+...`) are stripped to their bare identifier before we
  // decide whether to reject the entry. After normalization only the
  // conversation-target prefixes (chat_id / chat_guid / chat_identifier) remain
  // as illegal approver shapes — service-prefixed direct handles are valid
  // approver values that map to a specific phone/email.
  const normalized = normalizeIMessageHandle(raw);
  if (
    !normalized ||
    normalized.startsWith("chat_id:") ||
    normalized.startsWith("chat_guid:") ||
    normalized.startsWith("chat_identifier:")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeIMessageApproverEntry(value: string | number): string | undefined {
  return String(value).trim() === "*" ? "*" : normalizeIMessageApproverId(value);
}

const imessageApproval = createChannelApprovalAuth({
  channelLabel: "iMessage",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveIMessageAccount({ cfg, accountId });
    return { allowFrom: account.config.allowFrom };
  },
  normalizeApprover: normalizeIMessageApproverEntry,
  normalizeSenderId: normalizeIMessageApproverId,
  isWildcardAuthorized: ({ purpose, approvers }) => purpose === "action" && approvers.includes("*"),
});

export const getIMessageApprovalApprovers = imessageApproval.resolveApprovers;
export const imessageApprovalAuth = imessageApproval.approvalAuth;
