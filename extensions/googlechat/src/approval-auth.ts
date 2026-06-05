// Googlechat plugin module implements approval auth behavior.
import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleChatAccount } from "./accounts.js";
import { isGoogleChatUserTarget, normalizeGoogleChatTarget } from "./targets.js";

export function normalizeGoogleChatApproverId(value: string | number): string | undefined {
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

export function getGoogleChatApprovalApprovers(params: {
  cfg: Parameters<typeof resolveGoogleChatAccount>[0]["cfg"];
  accountId?: string | null;
}): string[] {
  const account = resolveGoogleChatAccount(params).config;
  return resolveApprovalApprovers({
    allowFrom: account.dm?.allowFrom,
    defaultTo: account.defaultTo,
    normalizeApprover: normalizeGoogleChatApproverId,
  });
}

export const googleChatApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Google Chat",
  resolveApprovers: getGoogleChatApprovalApprovers,
  normalizeSenderId: (value) => normalizeGoogleChatApproverId(value),
});
