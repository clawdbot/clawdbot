import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credentials.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import { resolveExternalCliAuthProfiles } from "../../agents/auth-profiles/external-cli-sync.js";
import {
  recordRuntimeAuthMaterialization,
  type RuntimeAuthMaterialization,
} from "../../agents/auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityRef,
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
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
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
  // A prepared projection must hydrate from its own auth-store generation. Reading the global
  // snapshot can mix generations; treating this store as persisted loses resolved SecretRefs.
  const preparedRuntimeAuthStore = params.preparedAuthStore;
  const externalCliProviderIds =
    !params.preparedAuthStore && params.includeOpenAIExternalProfiles ? ["openai"] : [];
  const externalProfileIds = new Set(
    externalCliProviderIds.length
      ? resolveExternalCliAuthProfiles(authStore, {
          allowKeychainPrompt: false,
          providerIds: externalCliProviderIds,
        }).map(({ profileId }) => profileId)
      : [],
  );
  const resolver = createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    metadataSnapshot: params.metadataSnapshot,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    skipSetupProviderFallback: true,
    syntheticAuthProviderRefs: listEnabledSyntheticAuthProviderRefs(params),
    externalCliProviderIds,
    ...(preparedRuntimeAuthStore ? { preparedRuntimeAuthStore } : {}),
    routeResolverFactory: params.routeResolverFactory,
  });
  if (externalProfileIds.size === 0) {
    return resolver;
  }
  const evaluateModelAuth = (
    provider: string,
    ref: ModelAuthAvailabilityRef = {},
  ): ModelAuthAvailabilityEvaluation => {
    const evaluation = resolver.evaluateModelAuth(provider, ref);
    const route = evaluation.selectedRoute;
    const profileId = evaluation.selectedProfileId;
    if (
      evaluation.availability === true &&
      route &&
      profileId &&
      externalProfileIds.has(profileId)
    ) {
      const modelId = ref.modelId?.trim();
      if (modelId) {
        recordRuntimeAuthMaterialization({
          agentDir,
          provider,
          modelId,
          modelApi: route.api,
          modelBaseUrl: route.baseUrl,
          requestTransportOverrides: route.requestTransportOverrides,
          authMode:
            evaluation.selectedAuthMode ??
            (route.authRequirement === "subscription" ? "oauth" : "api-key"),
          runtimeOwnerId: "external-cli",
          authProfileId: profileId,
        });
      }
    }
    return evaluation;
  };
  return {
    ...resolver,
    evaluateModelAuth,
    resolveProviderAuthAvailability: (provider, ref) =>
      evaluateModelAuth(provider, ref).availability,
  };
}
