// Signal plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { resolveSignalTarget } from "./aliases.js";
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

const signalApproval = createChannelApprovalAuth({
  channelLabel: "Signal",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveSignalAccount({ cfg, accountId }).config;
    let defaultTo = account.defaultTo;
    if (typeof account.defaultTo === "string") {
      try {
        defaultTo =
          resolveSignalTarget({ cfg, accountId, input: account.defaultTo })?.to ??
          account.defaultTo;
      } catch {
        defaultTo = account.defaultTo;
      }
    }
    return { allowFrom: account.allowFrom, defaultTo };
  },
  normalizeApprover: normalizeSignalApproverId,
});

export const getSignalApprovalApprovers = signalApproval.resolveApprovers;
export const signalApprovalAuth = signalApproval.approvalAuth;
