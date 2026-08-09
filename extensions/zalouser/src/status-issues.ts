// Zalouser plugin module implements status issues behavior.
import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  coerceStatusIssueAccountId,
  readStatusIssueFields,
} from "openclaw/plugin-sdk/extension-shared";
import {
  standardDmPolicyOpenIssue,
  standardNotConfiguredIssue,
} from "openclaw/plugin-sdk/status-helpers";

const ZALOUSER_STATUS_FIELDS = [
  "accountId",
  "enabled",
  "configured",
  "linked",
  "dmPolicy",
  "lastError",
] as const;

export function collectZalouserStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readStatusIssueFields(entry, ZALOUSER_STATUS_FIELDS);
    if (!account) {
      continue;
    }
    const accountId = coerceStatusIssueAccountId(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }

    if (account.configured !== true || account.linked === false) {
      issues.push(
        standardNotConfiguredIssue({
          channel: "zalouser",
          accountId,
          message: "Not authenticated (no saved Zalo session).",
          fix: "Run: openclaw channels login --channel zalouser",
        }),
      );
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push(
        standardDmPolicyOpenIssue({
          channel: "zalouser",
          accountId,
          channelLabel: "Zalo Personal",
          configPath: "channels.zalouser",
        }),
      );
    }
  }
  return issues;
}
