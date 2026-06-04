// Resolves runtime group-policy settings for channels and sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GroupPolicy } from "./types.base.js";

type RuntimeGroupPolicyResolution = {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
};

type RuntimeGroupPolicyParams = {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  configuredFallbackPolicy?: GroupPolicy;
  missingProviderFallbackPolicy?: GroupPolicy;
};

/**
 * Resolve the effective group policy for a channel/provider runtime.
 * Missing provider config can fail closed separately from configured providers.
 */
export function resolveRuntimeGroupPolicy(
  params: RuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  const configuredFallbackPolicy = params.configuredFallbackPolicy ?? "open";
  const missingProviderFallbackPolicy = params.missingProviderFallbackPolicy ?? "allowlist";
  const groupPolicy = params.providerConfigPresent
    ? (params.groupPolicy ?? params.defaultGroupPolicy ?? configuredFallbackPolicy)
    : (params.groupPolicy ?? missingProviderFallbackPolicy);
  const providerMissingFallbackApplied =
    !params.providerConfigPresent && params.groupPolicy === undefined;
  return { groupPolicy, providerMissingFallbackApplied };
}

type ResolveProviderRuntimeGroupPolicyParams = {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
};

type GroupPolicyDefaultsConfig = {
  channels?: {
    defaults?: {
      groupPolicy?: GroupPolicy;
    };
  };
};

/** Read the shared channels default group policy used by provider-specific resolvers. */
export function resolveDefaultGroupPolicy(cfg: GroupPolicyDefaultsConfig): GroupPolicy | undefined {
  return cfg.channels?.defaults?.groupPolicy;
}

/** Human labels for the access surface blocked by a missing-provider fallback. */
export const GROUP_POLICY_BLOCKED_LABEL = {
  group: "group messages",
  guild: "guild messages",
  room: "room messages",
  channel: "channel messages",
  space: "space messages",
} as const;

/**
 * Resolve the standard channel-provider policy.
 * Configured providers default open; missing provider config defaults allowlist.
 */
export function resolveOpenProviderRuntimeGroupPolicy(
  params: ResolveProviderRuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  return resolveRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
    configuredFallbackPolicy: "open",
    missingProviderFallbackPolicy: "allowlist",
  });
}

/**
 * Resolve the strict channel-provider policy.
 * Configured and missing provider config both default allowlist.
 */
export function resolveAllowlistProviderRuntimeGroupPolicy(
  params: ResolveProviderRuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  return resolveRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
    configuredFallbackPolicy: "allowlist",
    missingProviderFallbackPolicy: "allowlist",
  });
}

const warnedMissingProviderGroupPolicy = new Set<string>();

/**
 * Log the missing-provider fail-closed fallback once per provider/account.
 * Returns true only when this call emitted the warning.
 */
export function warnMissingProviderGroupPolicyFallbackOnce(params: {
  providerMissingFallbackApplied: boolean;
  providerKey: string;
  accountId?: string;
  blockedLabel?: string;
  log: (message: string) => void;
}): boolean {
  if (!params.providerMissingFallbackApplied) {
    return false;
  }
  const key = `${params.providerKey}:${params.accountId ?? "*"}`;
  if (warnedMissingProviderGroupPolicy.has(key)) {
    return false;
  }
  warnedMissingProviderGroupPolicy.add(key);
  const blockedLabel = normalizeOptionalString(params.blockedLabel) || "group messages";
  params.log(
    `${params.providerKey}: channels.${params.providerKey} is missing; defaulting groupPolicy to "allowlist" (${blockedLabel} blocked until explicitly configured).`,
  );
  return true;
}

/**
 * Test helper. Keeps warning-cache state deterministic across test files.
 */
export function resetMissingProviderGroupPolicyFallbackWarningsForTesting(): void {
  warnedMissingProviderGroupPolicy.clear();
}
