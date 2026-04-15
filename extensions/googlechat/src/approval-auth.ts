import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveGoogleChatAccount } from "./accounts.js";
import { isGoogleChatUserTarget, normalizeGoogleChatTarget } from "./targets.js";

function normalizeGoogleChatApproverId(value: string | number): string | undefined {
  const normalized = normalizeGoogleChatTarget(String(value));
  if (!normalized || !isGoogleChatUserTarget(normalized)) {
    return undefined;
  }
  const suffix = normalizeLowercaseStringOrEmpty(normalized.slice("users/".length));
  if (!suffix || suffix.includes("@")) {
    return undefined;
  }
  return `users/${suffix}`;
}

export const googleChatApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Google Chat",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveGoogleChatAccount({ cfg, accountId }).config;
    return resolveApprovalApprovers({
      allowFrom: account.dm?.allowFrom,
      defaultTo: account.defaultTo,
      normalizeApprover: normalizeGoogleChatApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeGoogleChatApproverId(value),
});
