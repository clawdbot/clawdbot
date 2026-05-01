import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { normalizeProviderId } from "./provider-id.js";

type LiveProviderOwnerContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  ownerCache: Map<string, readonly string[]>;
};

function resolveCachedOwningPluginIdsForProvider(
  provider: string,
  context: LiveProviderOwnerContext,
): readonly string[] {
  const normalized = normalizeProviderId(provider);
  const cached = context.ownerCache.get(normalized);
  if (cached) {
    return cached;
  }
  const owners =
    resolveOwningPluginIdsForProvider({
      provider: normalized,
      config: context.config,
      workspaceDir: context.workspaceDir,
      env: context.env,
    }) ?? [];
  context.ownerCache.set(normalized, owners);
  return owners;
}

export function liveProvidersShareOwningPlugin(
  left: string,
  right: string,
  context: LiveProviderOwnerContext,
): boolean {
  const leftOwners = resolveCachedOwningPluginIdsForProvider(left, context);
  const rightOwners = resolveCachedOwningPluginIdsForProvider(right, context);
  return leftOwners.some((owner) => rightOwners.includes(owner));
}
