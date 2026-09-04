/** Resolves external auth overlays through metadata and synchronous provider hooks. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolveProviderPluginsForHooks } from "./provider-hook-runtime.js";
import { resolveExternalAuthProfileProviderPluginIds } from "./providers.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import type {
  ProviderExternalAuthProfile,
  ProviderResolveExternalAuthProfilesContext,
} from "./types.js";

export function resolveExternalAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveExternalAuthProfilesContext;
}): ProviderExternalAuthProfile[] {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const currentMetadataSnapshot = getCurrentPluginMetadataSnapshot({
    env,
    ...(params.config ? { config } : { requireDefaultDiscoveryContext: true }),
    ...(workspaceDir ? { workspaceDir } : { allowWorkspaceScopedSnapshot: true }),
  });
  const { manifestRegistry } =
    currentMetadataSnapshot ?? resolvePluginMetadataSnapshot({ config, workspaceDir, env });
  // A lifecycle-owned manifest is authoritative: no external-auth contracts means
  // no provider registry discovery or runtime activation is needed for this overlay.
  if (
    currentMetadataSnapshot &&
    !manifestRegistry.plugins.some((plugin) => plugin.contracts?.externalAuthProviders?.length)
  ) {
    return [];
  }
  const externalAuthPluginIds = resolveExternalAuthProfileProviderPluginIds({
    config: params.config,
    workspaceDir,
    env,
    manifestRegistry,
  });
  if (externalAuthPluginIds.length === 0) {
    return [];
  }
  const matches: ProviderExternalAuthProfile[] = [];
  for (const plugin of resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    env,
    onlyPluginIds: externalAuthPluginIds,
  })) {
    const profiles = plugin.resolveExternalAuthProfiles?.(params.context);
    if (!profiles || profiles.length === 0) {
      continue;
    }
    matches.push(...profiles);
  }
  return matches;
}
