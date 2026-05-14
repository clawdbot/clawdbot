import {
  applyChannelMatchMeta,
  buildChannelKeyCandidates,
  resolveChannelEntryMatchWithFallback,
  type ChannelMatchSource,
} from "openclaw/plugin-sdk/channel-targets";
import type { ChannelBotLoopProtectionConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSlackSlug } from "./allow-list.js";

export type SlackChannelConfigResolved = {
  allowed: boolean;
  requireMention: boolean;
  allowBots?: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  users?: Array<string | number>;
  skills?: string[];
  systemPrompt?: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

type SlackChannelConfigEntry = {
  enabled?: boolean;
  requireMention?: boolean;
  allowBots?: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  users?: Array<string | number>;
  skills?: string[];
  systemPrompt?: string;
};

export type SlackChannelConfigEntries = Record<string, SlackChannelConfigEntry>;

function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function resolveSlackChannelLabel(params: { channelId?: string; channelName?: string }) {
  const channelName = params.channelName?.trim();
  if (channelName) {
    const slug = normalizeSlackSlug(channelName);
    return `#${slug || channelName}`;
  }
  const channelId = params.channelId?.trim();
  return channelId ? `#${channelId}` : "unknown channel";
}

export function resolveSlackChannelConfig(params: {
  channelId: string;
  channelName?: string;
  channels?: SlackChannelConfigEntries;
  channelKeys?: string[];
  defaultRequireMention?: boolean;
  allowNameMatching?: boolean;
}): SlackChannelConfigResolved | null {
  const {
    channelId,
    channelName,
    channels,
    channelKeys,
    defaultRequireMention,
    allowNameMatching,
  } = params;
  const entries = channels ?? {};
  const keys = channelKeys ?? Object.keys(entries);
  const normalizedName = channelName ? normalizeSlackSlug(channelName) : "";
  const directName = channelName ? channelName.trim() : "";
  // Slack always delivers channel IDs in uppercase (e.g. C0ABC12345) but
  // operators commonly write them in lowercase in their config. Add both
  // case variants so the lookup is case-insensitive without requiring a full
  // entry-scan. buildChannelKeyCandidates deduplicates identical keys.
  const channelIdLower = normalizeLowercaseStringOrEmpty(channelId);
  const channelIdUpper = channelId.toUpperCase();
  const channelTarget = `channel:${channelId}`;
  const channelTargetLower = `channel:${channelIdLower}`;
  const channelTargetUpper = `channel:${channelIdUpper}`;
  const candidates = buildChannelKeyCandidates(
    channelId,
    channelIdLower !== channelId ? channelIdLower : undefined,
    channelIdUpper !== channelId ? channelIdUpper : undefined,
    channelTarget,
    channelTargetLower !== channelTarget ? channelTargetLower : undefined,
    channelTargetUpper !== channelTarget ? channelTargetUpper : undefined,
    allowNameMatching ? (channelName ? `#${directName}` : undefined) : undefined,
    allowNameMatching ? directName : undefined,
    allowNameMatching ? normalizedName : undefined,
  );
  const match = resolveChannelEntryMatchWithFallback({
    entries,
    keys: candidates,
    wildcardKey: "*",
  });
  const { entry: matched, wildcardEntry: fallback } = match;

  const requireMentionDefault = defaultRequireMention ?? true;
  if (keys.length === 0) {
    return { allowed: true, requireMention: requireMentionDefault };
  }
  if (!matched && !fallback) {
    return { allowed: false, requireMention: requireMentionDefault };
  }

  const resolved = matched ?? fallback ?? {};
  const allowed = firstDefined(resolved.enabled, fallback?.enabled, true) ?? true;
  const requireMention =
    firstDefined(resolved.requireMention, fallback?.requireMention, requireMentionDefault) ??
    requireMentionDefault;
  const allowBots = firstDefined(resolved.allowBots, fallback?.allowBots);
  const botLoopProtection = mergePairLoopGuardConfig(
    fallback?.botLoopProtection,
    matched?.botLoopProtection,
  );
  const users = firstDefined(resolved.users, fallback?.users);
  const skills = firstDefined(resolved.skills, fallback?.skills);
  const systemPrompt = firstDefined(resolved.systemPrompt, fallback?.systemPrompt);
  const result: SlackChannelConfigResolved = {
    allowed,
    requireMention,
    allowBots,
    botLoopProtection,
    users,
    skills,
    systemPrompt,
  };
  return applyChannelMatchMeta(result, match);
}
