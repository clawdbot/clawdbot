import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { looksLikeUuid } from "./uuid.js";

function normalizeSignalApproverId(value: string | number): string | undefined {
  const normalized = normalizeSignalMessagingTarget(String(value));
  if (!normalized || normalized.startsWith("group:") || normalized.startsWith("username:")) {
    return undefined;
  }
  if (looksLikeUuid(normalized)) {
    return `uuid:${normalized}`;
  }
  const e164 = normalizeE164(normalized);
  return e164.length > 1 ? e164 : undefined;
}

export const signalApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Signal",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveSignalAccount({ cfg, accountId }).config;
    return resolveApprovalApprovers({
      allowFrom: account.allowFrom,
      defaultTo: account.defaultTo,
      normalizeApprover: normalizeSignalApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeSignalApproverId(value),
});
