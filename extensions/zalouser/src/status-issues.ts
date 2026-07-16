import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  coerceStatusIssueAccountId,
  readStatusIssueFields,
} from "openclaw/plugin-sdk/extension-shared";

const ZALOUSER_STATUS_FIELDS = [
  "accountId",
  "enabled",
  "configured",
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

    const configured = account.configured === true;

    if (!configured) {
      issues.push({
        channel: "zalouser",
        accountId,
        kind: "auth",
        message: "Not authenticated (no saved Zalo session).",
        fix: "Run: openclaw channels login --channel zalouser",
      });
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push({
        channel: "zalouser",
        accountId,
        kind: "config",
        message:
          'Zalo Personal dmPolicy is "open", allowing any user to message the bot without pairing.',
        fix: 'Set channels.zalouser.dmPolicy to "pairing" or "allowlist" to restrict access.',
      });
    }
  }
  return issues;
}
