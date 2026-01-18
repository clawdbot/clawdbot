import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";
import { appendMatchMetadata, asString, isRecord } from "./shared.js";

type DiscordIntentSummary = {
  messageContent?: "enabled" | "limited" | "disabled";
};

type DiscordApplicationSummary = {
  intents?: DiscordIntentSummary;
};

type DiscordAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  application?: unknown;
  audit?: unknown;
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

function readDiscordAccountStatus(value: ChannelAccountSnapshot): DiscordAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    application: value.application,
    audit: value.audit,
  };
}

function readDiscordApplicationSummary(value: unknown): DiscordApplicationSummary {
  if (!isRecord(value)) return {};
  const intentsRaw = value.intents;
  if (!isRecord(intentsRaw)) return {};
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
  if (!isRecord(value)) return {};
  const unresolvedChannels =
    typeof value.unresolvedChannels === "number" && Number.isFinite(value.unresolvedChannels)
      ? value.unresolvedChannels
      : undefined;
  const channelsRaw = value.channels;
  const channels = Array.isArray(channelsRaw)
    ? (channelsRaw
        .map((entry) => {
          if (!isRecord(entry)) return null;
          const channelId = asString(entry.channelId);
          if (!channelId) return null;
          const ok = typeof entry.ok === "boolean" ? entry.ok : undefined;
          const missing = Array.isArray(entry.missing)
            ? entry.missing.map((v) => asString(v)).filter(Boolean)
            : undefined;
          const error = asString(entry.error) ?? null;
          const matchKey = asString(entry.matchKey) ?? undefined;
          const matchSource = asString(entry.matchSource) ?? undefined;
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
    const account = readDiscordAccountStatus(entry);
    if (!account) continue;
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    const configured = account.configured === true;
    if (!enabled || !configured) continue;

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
      if (channel.ok === true) continue;
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
