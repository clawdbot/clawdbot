// Resolves provider thinking-level policy from active plugins or plugin metadata.
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { resolveProviderPolicySurface } from "./provider-public-artifacts.js";
import {
  resolveActiveProviderBinaryThinking,
  resolveActiveProviderDefaultThinkingLevel,
  resolveActiveProviderThinkingProfile,
  resolveActiveProviderXHighThinking,
} from "./provider-thinking-active.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";

function resolveProviderPublicPolicySurface(providerId: string) {
  const metadataSnapshot = getCurrentPluginMetadataSnapshot({
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  return resolveProviderPolicySurface(providerId, {
    manifestRegistry: metadataSnapshot?.manifestRegistry,
  });
}

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
};

/** Resolves whether a provider treats thinking as binary on/off. */
export function resolveProviderBinaryThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  return resolveActiveProviderBinaryThinking(params);
}

/** Resolves whether a provider supports xhigh thinking. */
export function resolveProviderXHighThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  return resolveActiveProviderXHighThinking(params);
}

/** Resolves a provider thinking profile from active plugins or bundled policy surface. */
export function resolveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
  options?: { allowPublicArtifactFallback?: boolean },
) {
  const activeProfile = resolveActiveProviderThinkingProfile(params);
  if (activeProfile !== undefined) {
    return activeProfile;
  }
  if (options?.allowPublicArtifactFallback === false) {
    return undefined;
  }
  return resolveProviderPublicPolicySurface(params.provider)?.resolveThinkingProfile?.(
    params.context,
  );
}

/** Resolves the provider default thinking level from the active plugin registry. */
export function resolveProviderDefaultThinkingLevel(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveProviderDefaultThinkingLevel(params);
}
