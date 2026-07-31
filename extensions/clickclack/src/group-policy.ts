/**
 * Resolved group/channel policy for ClickClack inbound gating.
 *
 * Pure helper – no side effects, no runtime imports.
 */

type ClickClackGroupPolicy = {
  requireMention: boolean;
  mentionPatterns: string[];
};

type ClickClackAccountGroupPolicyParams = {
  requireMention?: boolean;
  mentionPatterns?: string[];
  groups?: Record<string, { requireMention?: boolean; mentionPatterns?: string[] }>;
};

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
  const wildcard = account.groups?.["*"];
  const channelKey = channelId?.trim();
  const exact = channelKey ? account.groups?.[channelKey] : undefined;
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
