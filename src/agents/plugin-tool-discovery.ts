import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { collectExplicitAllowlist } from "./tool-policy.js";

/**
 * Derives the pre-filter plugin discovery surface from existing prepared policy state.
 * Restrictive profiles contribute core-tool ids only, so omit them here; full keeps its
 * wildcard to preserve the existing unrestricted optional-plugin surface.
 */
export function resolvePluginToolDiscoveryAllowlist(
  capabilityProfile: ResolvedConversationCapabilityProfile,
): string[] {
  const { policy } = capabilityProfile;
  return collectExplicitAllowlist([
    policy.profile === "full" ? policy.profilePolicy : undefined,
    policy.providerProfile === "full" ? policy.providerProfilePolicy : undefined,
    { allow: policy.explicitToolOverrideAllowlist },
    policy.inheritedToolPolicy,
  ]);
}
