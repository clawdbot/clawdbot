// Resolves provider thinking-level policy from active plugins or plugin metadata.
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { resolveProviderPolicySurface } from "./provider-public-artifacts.js";
import { resolveActiveProviderThinkingProfile } from "./provider-thinking-active.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingRegistry,
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

/** Resolves a provider thinking profile from active plugins or bundled policy surface. */
export function resolveEffectiveThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
  options?: { allowPublicArtifactFallback?: boolean; registry?: ProviderThinkingRegistry },
) {
  const activeProfile = resolveActiveProviderThinkingProfile(params, options?.registry);
  if (activeProfile !== undefined) {
    return activeProfile;
  }
  // A captured owner is authoritative even when its registry has no matching hook.
  if (options?.registry || options?.allowPublicArtifactFallback === false) {
    return undefined;
  }
  return resolveProviderPublicPolicySurface(params.provider)?.resolveThinkingProfile?.(
    params.context,
  );
}
