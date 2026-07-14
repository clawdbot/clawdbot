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
import { loadPluginRegistrySnapshotWithMetadata } from "../../plugins/plugin-registry.js";

export type ModelListAuthRef = ModelAuthAvailabilityRef;
export type ModelListAuthEvaluation = ModelAuthAvailabilityEvaluation;

export type ModelListAuthIndex = {
  evaluateModelAuth(provider: string, ref?: ModelListAuthRef): ModelListAuthEvaluation;
};

type CreateModelListAuthIndexParams = {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
  externalCliProviderIds?: readonly string[];
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
};

function listValidatedSyntheticAuthProviderRefs(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): readonly string[] {
  if (params.metadataSnapshot && (params.metadataSnapshot.registryDiagnostics?.length ?? 0) > 0) {
    return [];
  }
  const result = loadPluginRegistrySnapshotWithMetadata({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    index: params.metadataSnapshot?.index,
  });
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  return result.snapshot.plugins
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
    syntheticAuthProviderRefs:
      params.syntheticAuthProviderRefs ??
      listValidatedSyntheticAuthProviderRefs({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        env,
        metadataSnapshot: params.metadataSnapshot,
      }),
  });
  return {
    evaluateModelAuth: (provider, ref) => resolver.evaluateModelAuth(provider, ref),
  };
}
