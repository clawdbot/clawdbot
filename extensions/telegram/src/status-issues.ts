import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import {
  appendMatchMetadata,
  asString,
  isRecord,
  resolveEnabledConfiguredAccountId,
} from "openclaw/plugin-sdk/status-helpers";

const TELEGRAM_POLLING_CONNECT_GRACE_MS = 120_000;
const TELEGRAM_POLLING_STALE_TRANSPORT_MS = 30 * 60_000;
const TELEGRAM_WEBHOOK_CONNECT_GRACE_MS = 120_000;

type TelegramAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  running?: unknown;
  connected?: unknown;
  mode?: unknown;
  lastStartAt?: unknown;
  lastTransportActivityAt?: unknown;
  lastError?: unknown;
  allowUnmentionedGroups?: unknown;
  audit?: unknown;
};

type TelegramGroupMembershipAuditSummary = {
  unresolvedGroups?: number;
  hasWildcardUnmentionedGroups?: boolean;
  groups?: Array<{
    chatId: string;
    ok?: boolean;
    status?: string | null;
    error?: string | null;
    matchKey?: string;
    matchSource?: string;
  }>;
};

function readTelegramAccountStatus(value: ChannelAccountSnapshot): TelegramAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    running: value.running,
    connected: value.connected,
    mode: value.mode,
    lastStartAt: value.lastStartAt,
    lastTransportActivityAt: value.lastTransportActivityAt,
    lastError: value.lastError,
    allowUnmentionedGroups: value.allowUnmentionedGroups,
    audit: value.audit,
  };
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function appendTelegramRuntimeError(message: string, lastError: unknown): string {
  const error = asString(lastError);
  return error ? `${message}: ${error}` : message;
}

function collectTelegramPollingRuntimeIssues(params: {
  account: TelegramAccountStatus;
  accountId: string;
  issues: ChannelStatusIssue[];
  now: number;
}) {
  const { account, accountId, issues, now } = params;
  if (account.running !== true || asString(account.mode) !== "polling") {
    return;
  }

  const lastStartAt = asFiniteNumber(account.lastStartAt);
  const lastTransportActivityAt = asFiniteNumber(account.lastTransportActivityAt);
  const fix = `Run: ${formatCliCommand("openclaw channels status --probe")} (or restart the gateway). Check the bot token, proxy/network settings, and logs if it persists.`;

  if (account.connected === false) {
    const withinStartupGrace =
      lastStartAt != null && now - lastStartAt < TELEGRAM_POLLING_CONNECT_GRACE_MS;
    if (!withinStartupGrace) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "runtime",
        message: appendTelegramRuntimeError(
          "Telegram polling is running but has not completed a successful getUpdates call since startup",
          account.lastError,
        ),
        fix,
      });
    }
    return;
  }

  if (account.connected === true && lastTransportActivityAt != null) {
    if (lastStartAt != null && lastTransportActivityAt < lastStartAt) {
      const lifecycleAgeMs = Math.max(0, now - lastStartAt);
      if (lifecycleAgeMs <= TELEGRAM_POLLING_STALE_TRANSPORT_MS) {
        return;
      }
    }
    const ageMs = now - lastTransportActivityAt;
    if (ageMs > TELEGRAM_POLLING_STALE_TRANSPORT_MS) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "runtime",
        message: appendTelegramRuntimeError(
          `Telegram polling transport is stale (last successful getUpdates ${Math.max(0, Math.floor(ageMs / 60_000))}m ago)`,
          account.lastError,
        ),
        fix,
      });
    }
  }
}

function collectTelegramWebhookRuntimeIssues(params: {
  account: TelegramAccountStatus;
  accountId: string;
  issues: ChannelStatusIssue[];
  now: number;
}) {
  const { account, accountId, issues, now } = params;
  if (account.running !== true || asString(account.mode) !== "webhook") {
    return;
  }

  if (account.connected !== false) {
    return;
  }

  const lastStartAt = asFiniteNumber(account.lastStartAt);
  const withinStartupGrace =
    lastStartAt != null && now - lastStartAt < TELEGRAM_WEBHOOK_CONNECT_GRACE_MS;
  if (withinStartupGrace) {
    return;
  }

  issues.push({
    channel: "telegram",
    accountId,
    kind: "runtime",
    message: appendTelegramRuntimeError(
      "Telegram webhook listener is running but setWebhook has not completed since startup",
      account.lastError,
    ),
    fix: `Run: ${formatCliCommand("openclaw channels status --probe")} (or restart the gateway). Check the webhook URL, secret, TLS/proxy reachability, and Telegram setWebhook logs if it persists.`,
  });
}

function readTelegramGroupMembershipAuditSummary(
  value: unknown,
): TelegramGroupMembershipAuditSummary {
  if (!isRecord(value)) {
    return {};
  }
  const unresolvedGroups =
    typeof value.unresolvedGroups === "number" && Number.isFinite(value.unresolvedGroups)
      ? value.unresolvedGroups
      : undefined;
  const hasWildcardUnmentionedGroups =
    typeof value.hasWildcardUnmentionedGroups === "boolean"
      ? value.hasWildcardUnmentionedGroups
      : undefined;
  const groupsRaw = value.groups;
  const groups = Array.isArray(groupsRaw)
    ? (groupsRaw
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }
          const chatId = asString(entry.chatId);
          if (!chatId) {
            return null;
          }
          const ok = typeof entry.ok === "boolean" ? entry.ok : undefined;
          const status = asString(entry.status) ?? null;
          const error = asString(entry.error) ?? null;
          const matchKey = asString(entry.matchKey) ?? undefined;
          const matchSource = asString(entry.matchSource) ?? undefined;
          return { chatId, ok, status, error, matchKey, matchSource };
        })
        .filter(Boolean) as TelegramGroupMembershipAuditSummary["groups"])
    : undefined;
  return { unresolvedGroups, hasWildcardUnmentionedGroups, groups };
}

export function collectTelegramStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readTelegramAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = resolveEnabledConfiguredAccountId(account);
    if (!accountId) {
      continue;
    }
    const now = Date.now();

    collectTelegramPollingRuntimeIssues({
      account,
      accountId,
      issues,
      now,
    });
    collectTelegramWebhookRuntimeIssues({
      account,
      accountId,
      issues,
      now,
    });

    if (account.allowUnmentionedGroups === true) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message:
          "Config allows unmentioned group messages (requireMention=false). Telegram Bot API privacy mode will block most group messages unless disabled.",
        fix: "In BotFather run /setprivacy → Disable for this bot (then restart the gateway).",
      });
    }

    const audit = readTelegramGroupMembershipAuditSummary(account.audit);
    if (audit.hasWildcardUnmentionedGroups === true) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message:
          'Telegram groups config uses "*" with requireMention=false; membership probing is not possible without explicit group IDs.',
        fix: "Add explicit numeric group ids under channels.telegram.groups (or per-account groups) to enable probing.",
      });
    }
    if (audit.unresolvedGroups && audit.unresolvedGroups > 0) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message: `Some configured Telegram groups are not numeric IDs (unresolvedGroups=${audit.unresolvedGroups}). Membership probe can only check numeric group IDs.`,
        fix: "Use numeric chat IDs (e.g. -100...) as keys in channels.telegram.groups for requireMention=false groups.",
      });
    }
    for (const group of audit.groups ?? []) {
      if (group.ok === true) {
        continue;
      }
      const status = group.status ? ` status=${group.status}` : "";
      const err = group.error ? `: ${group.error}` : "";
      const baseMessage = `Group ${group.chatId} not reachable by bot.${status}${err}`;
      issues.push({
        channel: "telegram",
        accountId,
        kind: "runtime",
        message: appendMatchMetadata(baseMessage, {
          matchKey: group.matchKey,
          matchSource: group.matchSource,
        }),
        fix: "Invite the bot to the group, then DM the bot once (/start) and restart the gateway.",
      });
    }
  }
  return issues;
}
