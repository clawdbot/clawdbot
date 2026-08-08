import { resolveAgentDir } from "../../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityResolver,
} from "../../agents/model-auth-availability.js";
import { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { loadPluginRegistrySnapshotWithMetadata } from "../../plugins/plugin-registry.js";

function listEnabledSyntheticAuthProviderRefs(params: {
  cfg: OpenClawConfig;
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir: string;
}): readonly string[] {
  if (params.metadataSnapshot) {
    return params.metadataSnapshot.index.plugins
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
  }
  const result = loadPluginRegistrySnapshotWithMetadata({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
  });
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  return result.snapshot.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

export function createModelsListAuthResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeOpenAIExternalProfiles: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  preparedAuthStore?: AuthProfileStore;
  workspaceDir: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}): ModelAuthAvailabilityResolver {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  // Browse reads persisted auth because another CLI process may have refreshed
  // it after the Gateway execution snapshot was built.
  const authStore =
    params.preparedAuthStore ??
    loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
      allowKeychainPrompt: false,
    });
  return createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    metadataSnapshot: params.metadataSnapshot,
    skipSetupProviderFallback: true,
    syntheticAuthProviderRefs: listEnabledSyntheticAuthProviderRefs(params),
    externalCliProviderIds:
      !params.preparedAuthStore && params.includeOpenAIExternalProfiles ? ["openai"] : [],
    ...(params.preparedAuthStore ? { allowPreparedRuntimeAuth: false } : {}),
    routeResolverFactory: params.routeResolverFactory,
  });
}
