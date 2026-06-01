import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MentionPatternsMode, MentionPatternsPolicyConfig } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ResolveMentionPatternPolicyParams = {
  cfg?: OpenClawConfig;
  provider?: string;
  conversationId?: string | null;
  providerPolicy?: MentionPatternsPolicyConfig;
  agentId?: string;
};

export type ResolvedMentionPatternPolicy = {
  effectiveMode: MentionPatternsMode;
  allowMatched: boolean;
  denyMatched: boolean;
  enabled: boolean;
};

function normalizeIdList(values?: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const next = normalizeOptionalString(value);
    if (next) {
      normalized.add(next);
    }
  }
  return normalized;
}

function isMentionPatternsPolicyConfig(value: unknown): value is MentionPatternsPolicyConfig {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function resolveProviderMentionPatternsPolicy(
  cfg: OpenClawConfig | undefined,
  provider: string | undefined,
): MentionPatternsPolicyConfig | undefined {
  if (!cfg || !provider) {
    return undefined;
  }
  const channelConfig = cfg.channels?.[provider];
  const policy = isRecord(channelConfig) ? channelConfig.mentionPatterns : undefined;
  return isMentionPatternsPolicyConfig(policy) ? policy : undefined;
}

export function resolveMentionPatternPolicy(
  params: ResolveMentionPatternPolicyParams,
): ResolvedMentionPatternPolicy {
  const conversationId = normalizeOptionalString(params.conversationId ?? undefined) ?? undefined;
  const providerPolicy =
    params.providerPolicy ?? resolveProviderMentionPatternsPolicy(params.cfg, params.provider);
  const effectiveMode =
    providerPolicy?.mode === "allow" || providerPolicy?.mode === "deny"
      ? providerPolicy.mode
      : "allow";
  const allowMatched =
    conversationId != null && normalizeIdList(providerPolicy?.allowIn).has(conversationId);
  const denyMatched =
    conversationId != null && normalizeIdList(providerPolicy?.denyIn).has(conversationId);
  const enabled = effectiveMode === "allow" ? !denyMatched : allowMatched && !denyMatched;

  return { effectiveMode, allowMatched, denyMatched, enabled };
}
