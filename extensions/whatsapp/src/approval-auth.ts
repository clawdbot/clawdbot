import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { normalizeWhatsAppTarget } from "./normalize.js";

function normalizeWhatsAppApproverId(value: string | number): string | undefined {
  const normalized = normalizeWhatsAppTarget(String(value));
  if (!normalized || normalized.endsWith("@g.us")) {
    return undefined;
  }
  return normalized;
}

export const whatsappApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "WhatsApp",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    return resolveApprovalApprovers({
      allowFrom: account.allowFrom,
      defaultTo: account.defaultTo,
      normalizeApprover: normalizeWhatsAppApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeWhatsAppApproverId(value),
});
