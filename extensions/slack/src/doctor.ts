// Slack plugin module implements doctor behavior.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { listSlackAccountIds, mergeSlackAccountConfig } from "./accounts.js";
import {
  legacyConfigRules as SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeSlackCompatibilityConfig,
} from "./doctor-contract.js";
import { isSlackMutableAllowEntry } from "./security-doctor.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const collectSlackMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "slack",
    detector: isSlackMutableAllowEntry,
    collectLists: (scope) =>
      collectStandardAllowlistLists(scope, {
        includeGroupAllowFrom: false,
        includeDm: true,
        includeGroups: true,
        groupsKey: "channels",
        groupField: "users",
      }),
  });

const SLACK_CANONICAL_CHANNEL_ID_RE = /^[CG][A-Z0-9]{8,}$/;
const SLACK_LOWERCASE_CHANNEL_ID_RE = /^[cg][0-9][a-z0-9]{7,}$/;
const SLACK_PREFIXED_CANONICAL_CHANNEL_ID_RE = /^channel:[CG][A-Z0-9]{8,}$/;
const SLACK_PREFIXED_LOWERCASE_CHANNEL_ID_RE = /^channel:[cg][0-9][a-z0-9]{7,}$/;
const SLACK_CANONICAL_DM_ID_RE = /^(?:channel:)?D[A-Z0-9]{8,}$/;
const SLACK_PREFIXED_LOWERCASE_DM_ID_RE = /^channel:d[a-z0-9]{8,}$/;
const SLACK_AMBIGUOUS_LOWERCASE_DM_ID_RE = /^d[a-z0-9]{8,}$/;
// Letter-leading lowercase forms may be valid IDs or human names. Warn conditionally instead of
// claiming they are unroutable.
const SLACK_AMBIGUOUS_LOWERCASE_CHANNEL_ID_RE = /^(?:channel:)?[cgd][a-z][a-z0-9]{7,}$/;
// Slack supports international channel names, and runtime name matching preserves exact names.
// Keep Unicode letters/marks/numbers while enforcing lowercase, length, and punctuation rules.
const SLACK_CHANNEL_NAME_RE = /^[\p{L}\p{M}\p{N}_-]{1,80}$/u;
const SLACK_CHANNEL_NAME_ALPHANUMERIC_RE = /[\p{L}\p{N}]/u;

function looksLikeSlackChannelId(channelKey: string): boolean {
  return (
    SLACK_CANONICAL_CHANNEL_ID_RE.test(channelKey) ||
    SLACK_LOWERCASE_CHANNEL_ID_RE.test(channelKey) ||
    SLACK_PREFIXED_CANONICAL_CHANNEL_ID_RE.test(channelKey) ||
    SLACK_PREFIXED_LOWERCASE_CHANNEL_ID_RE.test(channelKey)
  );
}

function looksLikeSlackDmId(channelKey: string): boolean {
  return (
    SLACK_CANONICAL_DM_ID_RE.test(channelKey) || SLACK_PREFIXED_LOWERCASE_DM_ID_RE.test(channelKey)
  );
}

function looksLikeSlackChannelNameKey(channelKey: string): boolean {
  const name = channelKey.startsWith("#") ? channelKey.slice(1) : channelKey;
  return (
    name === name.toLowerCase() &&
    SLACK_CHANNEL_NAME_RE.test(name) &&
    SLACK_CHANNEL_NAME_ALPHANUMERIC_RE.test(name)
  );
}

// Startup resolution updates ctx.channelsConfig, but inbound authorization captures the authored
// channels map and key list when createSlackMonitorContext runs. Diagnose those authored keys.
function collectSlackNameKeyedChannelWarnings({ cfg }: { cfg: OpenClawConfig }): string[] {
  const warnings = new Set<string>();
  const slackCfg = asObjectRecord(asObjectRecord(cfg.channels)?.slack);
  const providerChannels = asObjectRecord(slackCfg?.channels);
  const accounts = asObjectRecord(slackCfg?.accounts);
  for (const accountId of listSlackAccountIds(cfg)) {
    const account = asObjectRecord(mergeSlackAccountConfig(cfg, accountId));
    if (!account || slackCfg?.enabled === false || account.enabled === false) {
      continue;
    }
    const scopedGroupPolicy =
      typeof account.groupPolicy === "string" ? (account.groupPolicy as GroupPolicy) : undefined;
    // Slack's schema materializes this provider default before runtime account merging.
    const effectiveGroupPolicy = scopedGroupPolicy ?? "allowlist";
    const rawAccount = asObjectRecord(accounts?.[accountId]);
    const accountPrefix = rawAccount ? `channels.slack.accounts.${accountId}` : "channels.slack";
    const accountChannels = asObjectRecord(rawAccount?.channels);
    const channels = accountChannels ?? providerChannels;
    if (!channels) {
      continue;
    }
    const channelsPrefix = accountChannels
      ? `channels.slack.accounts.${accountId}`
      : "channels.slack";
    const fallbackDescription = Object.hasOwn(channels, "*")
      ? `${channelsPrefix}.channels."*" applies instead and this entry's overrides are ignored`
      : effectiveGroupPolicy === "open"
        ? 'this entry\'s overrides are ignored and the channel remains allowed by groupPolicy: "open"'
        : "messages from the channel are dropped";
    for (const channelKey of Object.keys(channels)) {
      if (channelKey === "*") {
        continue;
      }
      if (looksLikeSlackDmId(channelKey)) {
        warnings.add(
          `${channelsPrefix}.channels."${channelKey}" is a Slack DM conversation ID, but ${channelsPrefix}.channels only configures channel and group rooms. ` +
            `Configure DM access with ${accountPrefix}.dmPolicy and ${accountPrefix}.allowFrom instead.`,
        );
        continue;
      }
      if (SLACK_AMBIGUOUS_LOWERCASE_DM_ID_RE.test(channelKey)) {
        if (
          account.dangerouslyAllowNameMatching === true &&
          looksLikeSlackChannelNameKey(channelKey)
        ) {
          continue;
        }
        warnings.add(
          `${channelsPrefix}.channels."${channelKey}" is ambiguous: it may be a lowercase Slack DM conversation ID or a channel name. ` +
            `Configure DMs with ${accountPrefix}.dmPolicy and ${accountPrefix}.allowFrom; otherwise re-key the room with its stable C/G ID.`,
        );
        continue;
      }
      if (effectiveGroupPolicy === "disabled") {
        continue;
      }
      const channelConfig = asObjectRecord(channels[channelKey]);
      if (effectiveGroupPolicy === "open" && Object.keys(channelConfig ?? {}).length === 0) {
        continue;
      }
      if (looksLikeSlackChannelId(channelKey)) {
        continue;
      }
      if (
        account.dangerouslyAllowNameMatching === true &&
        looksLikeSlackChannelNameKey(channelKey)
      ) {
        continue;
      }
      if (SLACK_AMBIGUOUS_LOWERCASE_CHANNEL_ID_RE.test(channelKey)) {
        warnings.add(
          `${channelsPrefix}.channels."${channelKey}" is ambiguous: it may be a lowercase Slack channel ID or a channel name. ` +
            `If it is a channel name, inbound routing will not match it and ${fallbackDescription}. ` +
            `Re-key it with the channel's stable ID (e.g. C0123ABCD, from the channel's About details or conversations.info).`,
        );
        continue;
      }
      warnings.add(
        `${channelsPrefix}.channels."${channelKey}" is keyed by a channel name or non-canonical ID form, not a routable Slack channel ID; ` +
          `under groupPolicy: "${effectiveGroupPolicy}" inbound routing does not match this entry, so ${fallbackDescription}. ` +
          `Re-key it with the channel's ID (e.g. C0123ABCD, from the channel's About details or conversations.info).`,
      );
    }
  }
  return [...warnings];
}

export const slackDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeSlackCompatibilityConfig,
  collectMutableAllowlistWarnings: ({ cfg }) => [
    ...collectSlackMutableAllowlistWarnings({ cfg }),
    ...collectSlackNameKeyedChannelWarnings({ cfg }),
  ],
};
