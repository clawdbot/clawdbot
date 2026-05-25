import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveIMessageAccount } from "./accounts.js";
import { normalizeIMessageHandle } from "./targets.js";

type ApprovalKind = "exec" | "plugin";

export function normalizeIMessageApproverId(value: string | number): string | undefined {
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

export function getIMessageApprovalApprovers(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  accountId?: string | null;
}): string[] {
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.accountId });
  return resolveApprovalApprovers({
    allowFrom: account.config.allowFrom,
    normalizeApprover: normalizeIMessageApproverEntry,
  });
}

const imessageResolvedApproverAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "iMessage",
  resolveApprovers: ({ cfg, accountId }) => getIMessageApprovalApprovers({ cfg, accountId }),
  normalizeSenderId: (value) => normalizeIMessageApproverId(value),
});

export const imessageApprovalAuth = {
  authorizeActorAction({
    cfg,
    accountId,
    senderId,
    approvalKind,
  }: {
    cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
    accountId?: string | null;
    senderId?: string | null;
    action: "approve";
    approvalKind: ApprovalKind;
  }) {
    if (getIMessageApprovalApprovers({ cfg, accountId }).includes("*")) {
      return { authorized: true } as const;
    }
    return imessageResolvedApproverAuth.authorizeActorAction({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind,
    });
  },
};
