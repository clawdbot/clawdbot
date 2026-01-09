import type {
  ProviderAccountSnapshot,
  ProviderStatusIssue,
} from "../types.js";
import { asString, isRecord } from "./shared.js";

type TelegramAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
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
  }>;
};

function readTelegramAccountStatus(
  value: ProviderAccountSnapshot,
): TelegramAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    allowUnmentionedGroups: value.allowUnmentionedGroups,
    audit: value.audit,
  };
}

function readTelegramGroupMembershipAuditSummary(
  value: unknown,
): TelegramGroupMembershipAuditSummary {
  if (!isRecord(value)) return {};
  const unresolvedGroups =
    typeof value.unresolvedGroups === "number" &&
    Number.isFinite(value.unresolvedGroups)
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
          if (!isRecord(entry)) return null;
          const chatId = asString(entry.chatId);
          if (!chatId) return null;
          const ok = typeof entry.ok === "boolean" ? entry.ok : undefined;
          const status = asString(entry.status) ?? null;
          const error = asString(entry.error) ?? null;
          return { chatId, ok, status, error };
        })
        .filter(Boolean) as TelegramGroupMembershipAuditSummary["groups"])
    : undefined;
  return { unresolvedGroups, hasWildcardUnmentionedGroups, groups };
}

export function collectTelegramStatusIssues(
  accounts: ProviderAccountSnapshot[],
): ProviderStatusIssue[] {
  const issues: ProviderStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readTelegramAccountStatus(entry);
    if (!account) continue;
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    const configured = account.configured === true;
    if (!enabled || !configured) continue;

    if (account.allowUnmentionedGroups === true) {
      issues.push({
        provider: "telegram",
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
        provider: "telegram",
        accountId,
        kind: "config",
        message:
          'Telegram groups config uses "*" with requireMention=false; membership probing is not possible without explicit group IDs.',
        fix: "Add explicit numeric group ids under telegram.groups (or per-account groups) to enable probing.",
      });
    }
    if (audit.unresolvedGroups && audit.unresolvedGroups > 0) {
      issues.push({
        provider: "telegram",
        accountId,
        kind: "config",
        message: `Some configured Telegram groups are not numeric IDs (unresolvedGroups=${audit.unresolvedGroups}). Membership probe can only check numeric group IDs.`,
        fix: "Use numeric chat IDs (e.g. -100...) as keys in telegram.groups for requireMention=false groups.",
      });
    }
    for (const group of audit.groups ?? []) {
      if (group.ok === true) continue;
      const status = group.status ? ` status=${group.status}` : "";
      const err = group.error ? `: ${group.error}` : "";
      issues.push({
        provider: "telegram",
        accountId,
        kind: "runtime",
        message: `Group ${group.chatId} not reachable by bot.${status}${err}`,
        fix: "Invite the bot to the group, then DM the bot once (/start) and restart the gateway.",
      });
    }
  }
  return issues;
}
