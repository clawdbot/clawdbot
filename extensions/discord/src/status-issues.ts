// Discord plugin module implements status issues behavior.
import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  appendMatchMetadata,
  isRecord,
  readAccountStatusSnapshot,
  resolveEnabledConfiguredAccountId,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type DiscordIntentSummary = {
  messageContent?: "enabled" | "limited" | "disabled";
};

type DiscordApplicationSummary = {
  intents?: DiscordIntentSummary;
};

type DiscordPermissionsAuditSummary = {
  unresolvedChannels?: number;
  channels?: Array<{
    channelId: string;
    ok?: boolean;
    missing?: string[];
    error?: string | null;
    matchKey?: string;
    matchSource?: string;
  }>;
};

function readDiscordApplicationSummary(value: unknown): DiscordApplicationSummary {
  if (!isRecord(value)) {
    return {};
  }
  const intentsRaw = value.intents;
  if (!isRecord(intentsRaw)) {
    return {};
  }
  return {
    intents: {
      messageContent:
        intentsRaw.messageContent === "enabled" ||
        intentsRaw.messageContent === "limited" ||
        intentsRaw.messageContent === "disabled"
          ? intentsRaw.messageContent
          : undefined,
    },
  };
}

function readDiscordPermissionsAuditSummary(value: unknown): DiscordPermissionsAuditSummary {
  if (!isRecord(value)) {
    return {};
  }
  const unresolvedChannels =
    typeof value.unresolvedChannels === "number" && Number.isFinite(value.unresolvedChannels)
      ? value.unresolvedChannels
      : undefined;
  const channelsRaw = value.channels;
  const channels = Array.isArray(channelsRaw)
    ? (channelsRaw
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }
          const channelId = normalizeOptionalString(entry.channelId);
          if (!channelId) {
            return null;
          }
          const ok = typeof entry.ok === "boolean" ? entry.ok : undefined;
          const missing = Array.isArray(entry.missing)
            ? entry.missing.map((v) => normalizeOptionalString(v)).filter(Boolean)
            : undefined;
          const error = normalizeOptionalString(entry.error) ?? null;
          const matchKey = normalizeOptionalString(entry.matchKey);
          const matchSource = normalizeOptionalString(entry.matchSource);
          return {
            channelId,
            ok,
            missing: missing?.length ? missing : undefined,
            error,
            matchKey,
            matchSource,
          };
        })
        .filter(Boolean) as DiscordPermissionsAuditSummary["channels"])
    : undefined;
  return { unresolvedChannels, channels };
}

export function collectDiscordStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readAccountStatusSnapshot(entry, ["application", "audit"]);
    if (!account) {
      continue;
    }
    const accountId = resolveEnabledConfiguredAccountId(account);
    if (!accountId) {
      continue;
    }

    const app = readDiscordApplicationSummary(account.application);
    const messageContent = app.intents?.messageContent;
    if (messageContent === "disabled") {
      issues.push({
        channel: "discord",
        accountId,
        kind: "intent",
        message: "Message Content Intent is disabled. Bot may not see normal channel messages.",
        fix: "Enable Message Content Intent in Discord Dev Portal → Bot → Privileged Gateway Intents, or require mention-only operation.",
      });
    }

    const audit = readDiscordPermissionsAuditSummary(account.audit);
    if (audit.unresolvedChannels && audit.unresolvedChannels > 0) {
      issues.push({
        channel: "discord",
        accountId,
        kind: "config",
        message: `Some configured guild channels are not numeric IDs (unresolvedChannels=${audit.unresolvedChannels}). Permission audit can only check numeric channel IDs.`,
        fix: "Use numeric channel IDs as keys in channels.discord.guilds.*.channels (then rerun channels status --probe).",
      });
    }
    for (const channel of audit.channels ?? []) {
      if (channel.ok === true) {
        continue;
      }
      const missing = channel.missing?.length ? ` missing ${channel.missing.join(", ")}` : "";
      const error = channel.error ? `: ${channel.error}` : "";
      const baseMessage = `Channel ${channel.channelId} permission check failed.${missing}${error}`;
      issues.push({
        channel: "discord",
        accountId,
        kind: "permissions",
        message: appendMatchMetadata(baseMessage, {
          matchKey: channel.matchKey,
          matchSource: channel.matchSource,
        }),
        fix: "Ensure the bot role can view + send in this channel (and that channel overrides don't deny it).",
      });
    }
  }
  return issues;
}
