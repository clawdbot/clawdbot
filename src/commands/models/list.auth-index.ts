import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
/** Auth availability index for `openclaw models list` rows. */
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
  type ModelAuthAvailabilityRef,
} from "../../agents/model-auth-availability.js";
import { resolveModelRuntimeAuthAvailability } from "../../agents/model-auth-runtime-fallback.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import { resolveMergedModelProviderConfig } from "../../config/model-provider-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderSyntheticAuthWithPlugin } from "../../plugins/provider-runtime.js";

export type ModelListAuthRef = ModelAuthAvailabilityRef;
export type ModelListAuthEvaluation = ModelAuthAvailabilityEvaluation;

export type ModelListAuthIndex = {
  providerDiscoveryProviderIds?: readonly string[];
  evaluateModelAuth(provider: string, ref?: ModelListAuthRef): ModelListAuthEvaluation;
};

type CreateModelListAuthIndexParams = {
  cfg: OpenClawConfig;
  agentId: string;
  authStore: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
  metadataSnapshot: PluginMetadataSnapshot;
  externalCliProviderIds?: readonly string[];
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
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
  const syntheticAuthProviderRefs = new Set(
    (
      params.syntheticAuthProviderRefs ??
      listValidatedSyntheticAuthProviderRefs({ metadataSnapshot: params.metadataSnapshot })
    ).map(normalizeProviderId),
  );
  const resolver = createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore: params.authStore,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env,
    metadataSnapshot: params.metadataSnapshot,
    externalCliProviderIds: params.externalCliProviderIds,
    routeResolverFactory: params.routeResolverFactory,
    syntheticAuthProviderRefs: [...syntheticAuthProviderRefs],
  });
  const runtimeAvailability = new Map<string, boolean | undefined>();
  const resolveRuntimeProviderAvailability = (provider: string) => {
    const normalized = normalizeProviderId(provider);
    if (!syntheticAuthProviderRefs.has(normalized)) {
      return undefined;
    }
    if (runtimeAvailability.has(normalized)) {
      return runtimeAvailability.get(normalized);
    }
    let available: boolean | undefined;
    try {
      const resolved = resolveProviderSyntheticAuthWithPlugin({
        provider: normalized,
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        env,
        context: {
          config: params.cfg,
          provider: normalized,
          providerConfig: resolveMergedModelProviderConfig(params.cfg, normalized),
        },
      });
      available = Boolean(resolved?.apiKey?.trim());
    } catch {
      available = undefined;
    }
    runtimeAvailability.set(normalized, available);
    return available;
  };
  return {
    providerDiscoveryProviderIds: resolver.providerDiscoveryProviderIds,
    evaluateModelAuth: (provider, ref) => {
      const evaluation = resolver.evaluateModelAuth(provider, ref);
      if (
        (evaluation.routeResolution !== null && evaluation.routeResolution !== undefined) ||
        normalizeProviderId(provider) === "openai" ||
        !ref?.modelId
      ) {
        return evaluation;
      }
      return {
        ...evaluation,
        availability: resolveModelRuntimeAuthAvailability({
          cfg: params.cfg,
          agentId: params.agentId,
          provider,
          modelId: ref.modelId,
          metadataSnapshot: params.metadataSnapshot,
          primaryAvailability: evaluation.availability,
          resolveProviderAvailability: resolveRuntimeProviderAvailability,
        }),
      };
    },
  };
}
