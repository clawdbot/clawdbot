// Zalo plugin module implements status issues behavior.
import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  coerceStatusIssueAccountId,
  readStatusIssueFields,
} from "openclaw/plugin-sdk/extension-shared";
import { standardDmPolicyOpenIssue } from "openclaw/plugin-sdk/status-helpers";

const ZALO_STATUS_FIELDS = ["accountId", "enabled", "configured", "dmPolicy"] as const;

export function collectZaloStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readStatusIssueFields(entry, ZALO_STATUS_FIELDS);
    if (!account) {
      continue;
    }
    const accountId = coerceStatusIssueAccountId(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    const configured = account.configured === true;
    if (!enabled || !configured) {
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push(
        standardDmPolicyOpenIssue({
          channel: "zalo",
          accountId,
          channelLabel: "Zalo",
          configPath: "channels.zalo",
        }),
      );
    }
  }
  return issues;
}
