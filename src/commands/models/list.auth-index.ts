/** Auth availability index for `openclaw models list` rows. */
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  applyCliRuntimeModelAuthAvailability,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityRef,
} from "../../agents/model-auth-availability.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

export type ModelListAuthRef = ModelAuthAvailabilityRef;
export type ModelListAuthEvaluation = ModelAuthAvailabilityEvaluation;

export type ModelListAuthIndex = {
  providerDiscoveryProviderIds?: readonly string[];
  evaluateModelAuth(provider: string, ref?: ModelListAuthRef): ModelListAuthEvaluation;
};

type CreateModelListAuthIndexParams = {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
  metadataSnapshot: PluginMetadataSnapshot;
  externalCliProviderIds?: readonly string[];
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
};

function listValidatedSyntheticAuthProviderRefs(params: {
  metadataSnapshot: PluginMetadataSnapshot;
}): readonly string[] {
  if (
    params.metadataSnapshot.registryDiagnostics.length > 0 ||
    (params.metadataSnapshot.registrySource !== "persisted" &&
      params.metadataSnapshot.registrySource !== "provided")
  ) {
    return [];
  }
  return params.metadataSnapshot.index.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

/** Builds one snapshot-scoped command adapter around the shared evaluator. */
export function createModelListAuthIndex(
  params: CreateModelListAuthIndexParams,
): ModelListAuthIndex {
  const env = params.env ?? process.env;
  const resolver = createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore: params.authStore,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env,
    metadataSnapshot: params.metadataSnapshot,
    externalCliProviderIds: params.externalCliProviderIds,
    routeResolverFactory: params.routeResolverFactory,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    syntheticAuthProviderRefs:
      params.syntheticAuthProviderRefs ??
      listValidatedSyntheticAuthProviderRefs({
        metadataSnapshot: params.metadataSnapshot,
      }),
  });
  return {
    providerDiscoveryProviderIds: resolver.providerDiscoveryProviderIds,
    evaluateModelAuth: (provider, ref) => {
      const evaluation = resolver.evaluateModelAuth(provider, ref);
      return applyCliRuntimeModelAuthAvailability({
        authResolver: resolver,
        evaluation,
        cfg: params.cfg,
        agentId: params.agentId,
        metadataSnapshot: params.metadataSnapshot,
        provider,
        modelId: ref?.modelId,
        preferredProfileId: ref?.preferredProfileId,
        lockedProfileId: ref?.lockedProfileId,
      });
    },
  };
}
