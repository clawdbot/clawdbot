import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveExternalCliAuthScopeFromConfig } from "../../agents/auth-profiles/external-cli-scope.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityResolver,
} from "../../agents/model-auth-availability.js";
import { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

function listEnabledSyntheticAuthProviderRefs(
  metadataSnapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): readonly string[] {
  return metadataSnapshot.plugins
    .filter((plugin) =>
      isManifestPluginAvailableForControlPlane({ snapshot: metadataSnapshot, plugin, config }),
    )
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

export function createModelsListAuthResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  workspaceDir: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}): ModelAuthAvailabilityResolver {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  return createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore: params.preparedAuthStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    metadataSnapshot: params.metadataSnapshot,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    skipSetupProviderFallback: true,
    syntheticAuthProviderRefs: listEnabledSyntheticAuthProviderRefs(
      params.metadataSnapshot,
      params.cfg,
    ),
    externalCliProviderIds: resolveExternalCliAuthScopeFromConfig(params.cfg)?.providerIds ?? [],
    preparedRuntimeAuthStore: params.preparedAuthStore,
    routeResolverFactory: params.routeResolverFactory,
  });
}
