import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
/** Auth availability index for `openclaw models list` rows. */
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityRef,
} from "../../agents/model-auth-availability.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveValidatedSyntheticAuthProviderRefState } from "../../plugins/synthetic-auth.runtime.js";

export type ModelListAuthRef = ModelAuthAvailabilityRef;
export type ModelListAuthEvaluation = ModelAuthAvailabilityEvaluation;

export type ModelListAuthIndex = {
  providerDiscoveryProviderIds?: readonly string[];
  evaluateModelAuth(provider: string, ref?: ModelListAuthRef): ModelListAuthEvaluation;
};

type CreateModelListAuthIndexParams = {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
  metadataSnapshot: PluginMetadataSnapshot;
  externalCliProviderIds?: readonly string[];
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
};

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
    syntheticAuthProviderRefs:
      params.syntheticAuthProviderRefs ??
      resolveValidatedSyntheticAuthProviderRefState(params.metadataSnapshot).refs,
  });
  return {
    providerDiscoveryProviderIds: resolver.providerDiscoveryProviderIds,
    evaluateModelAuth: (provider, ref) => resolver.evaluateModelAuth(provider, ref),
  };
}
