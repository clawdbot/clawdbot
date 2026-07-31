// Whatsapp plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { normalizeWhatsAppTarget } from "./normalize.js";

function normalizeWhatsAppApproverId(value: string | number): string | undefined {
  const normalized = normalizeWhatsAppTarget(String(value));
  if (!normalized || normalized.endsWith("@g.us")) {
    return undefined;
  }
  return normalized;
}

function normalizeWhatsAppApproverEntry(value: string | number): string | undefined {
  return String(value).trim() === "*" ? "*" : normalizeWhatsAppApproverId(value);
}

const whatsappApproval = createChannelApprovalAuth({
  channelLabel: "WhatsApp",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    return { allowFrom: account.allowFrom };
  },
  normalizeApprover: normalizeWhatsAppApproverEntry,
  normalizeSenderId: normalizeWhatsAppApproverId,
  isWildcardAuthorized: ({ purpose, approvers }) => purpose === "action" && approvers.includes("*"),
});

export const getWhatsAppApprovalApprovers = whatsappApproval.resolveApprovers;
export const whatsappApprovalAuth = whatsappApproval.approvalAuth;
