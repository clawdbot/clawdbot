import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./mattermost/accounts.js";

const MATTERMOST_USER_ID_RE = /^[a-z0-9]{26}$/;

function normalizeMattermostApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim();
  const lowered = normalizeLowercaseStringOrEmpty(normalized);
  return MATTERMOST_USER_ID_RE.test(lowered) ? lowered : undefined;
}

export const mattermostApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Mattermost",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveMattermostAccount({ cfg, accountId }).config;
    return resolveApprovalApprovers({
      allowFrom: account.allowFrom,
      normalizeApprover: normalizeMattermostApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeMattermostApproverId(value),
});
