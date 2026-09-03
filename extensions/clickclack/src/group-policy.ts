/**
 * Resolved group/channel policy for ClickClack inbound gating.
 *
 * Pure helper – no side effects, no runtime imports.
 */

import type { ChannelBotLoopProtectionConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";

type ClickClackGroupPolicy = {
  requireMention: boolean;
  mentionPatterns: string[];
};

type ClickClackAccountGroupPolicyParams = {
  requireMention?: boolean;
  mentionPatterns?: string[];
  groups?: Record<string, { requireMention?: boolean; mentionPatterns?: string[] }>;
};

type ClickClackBotPolicy = {
  allowBots: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
};

type ClickClackBotPolicyParams = {
  allowBots?: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  groups?: Record<
    string,
    {
      allowBots?: boolean | "mentions";
      botLoopProtection?: ChannelBotLoopProtectionConfig;
    }
  >;
};

/**
 * Resolves bot-authored message policy using the same exact, wildcard, and
 * account-level precedence as mention gating.
 */
export function resolveClickClackBotPolicy(params: {
  account: ClickClackBotPolicyParams;
  channelId?: string;
}): ClickClackBotPolicy {
  const { account, channelId } = params;
  const channelKey = channelId?.trim();
  // Group-scoped policy must not affect direct messages, which have no
  // channel ID. In particular, groups["*"] is a channel fallback, not an
  // account-wide override.
  const groups = channelKey ? account.groups : undefined;
  const wildcard = groups?.["*"];
  const exact = channelKey ? groups?.[channelKey] : undefined;
  return {
    allowBots: exact?.allowBots ?? wildcard?.allowBots ?? account.allowBots ?? false,
    botLoopProtection: mergePairLoopGuardConfig(
      account.botLoopProtection,
      wildcard?.botLoopProtection,
      exact?.botLoopProtection,
    ),
  };
}

/**
 * Resolves the effective group policy for a ClickClack channel.
 *
 * Lookup order:
 *  1. Exact channel ID in `groups`
 *  2. Wildcard `'*'` entry in `groups`
 *  3. Account-level `requireMention` / `mentionPatterns`
 *  4. Backward-compatible default: { requireMention: false, mentionPatterns: [] }
 */
export function resolveClickClackGroupPolicy(params: {
  account: ClickClackAccountGroupPolicyParams;
  channelId?: string;
}): ClickClackGroupPolicy {
  const { account, channelId } = params;
  const accountPolicy: ClickClackGroupPolicy = {
    requireMention: account.requireMention === true,
    mentionPatterns: account.mentionPatterns ?? [],
  };
  const channelKey = channelId?.trim();
  // Group-scoped policy must not affect direct messages, which have no
  // channel ID. In particular, groups["*"] is a channel fallback, not an
  // account-wide override.
  const groups = channelKey ? account.groups : undefined;
  const wildcard = groups?.["*"];
  const exact = channelKey ? groups?.[channelKey] : undefined;
  // Channel rules are partial overrides. Resolve each field independently so
  // an exact channel rule can inherit unspecified fields from the wildcard
  // rule before falling back to the account-level policy.
  return {
    requireMention:
      exact?.requireMention ?? wildcard?.requireMention ?? accountPolicy.requireMention,
    mentionPatterns:
      exact?.mentionPatterns ?? wildcard?.mentionPatterns ?? accountPolicy.mentionPatterns,
  };
}
