// Google Chat message-tool discovery stays read-only and account-isolated.
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { inspectGoogleChatAccount, listGoogleChatAccountIds } from "./accounts.js";

export function describeGoogleChatMessageTool({
  cfg,
  accountId,
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]) {
  const accounts = accountId
    ? [inspectGoogleChatAccount({ cfg, accountId })]
    : listGoogleChatAccountIds(cfg).map((listedAccountId) =>
        inspectGoogleChatAccount({ cfg, accountId: listedAccountId }),
      );
  const hasAvailableAccount = accounts.some(
    (account) =>
      account.enabled && account.credentialSource !== "none" && account.tokenStatus === "available",
  );
  return hasAvailableAccount ? { actions: ["send" as const] } : null;
}
