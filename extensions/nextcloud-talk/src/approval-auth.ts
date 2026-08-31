// Nextcloud Talk plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

function normalizeNextcloudTalkApproverId(value: string | number): string | undefined {
  return normalizeOptionalLowercaseString(
    String(value)
      .trim()
      .replace(/^(nextcloud-talk|nc-talk|nc):/i, ""),
  );
}

export const nextcloudTalkApprovalAuth = createChannelApprovalAuth({
  channelLabel: "Nextcloud Talk",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
    return { allowFrom: account.config.allowFrom };
  },
  normalizeApprover: normalizeNextcloudTalkApproverId,
}).approvalAuth;
