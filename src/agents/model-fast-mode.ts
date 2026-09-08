import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";

/** Capture light policy with the private catalog owner; published row reads cannot load plugins. */
export function createModelFastModeResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  catalog: readonly ModelCatalogEntry[];
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
}) {
  const policies = withPluginCache(
    getPluginMetadataSnapshotCache(params.metadataSnapshot),
    () =>
      new Map(
        [...new Set(params.catalog.map((entry) => normalizeProviderId(entry.provider)))].map(
          (provider) => [
            provider,
            params.pluginRegistry?.providers.find(({ provider: candidate }) =>
              matchesProviderPluginRef(candidate, provider),
            )?.provider.resolveFastModeSupport ??
              resolveProviderPolicySurface(provider, {
                manifestRegistry: params.metadataSnapshot.manifestRegistry,
              })?.resolveFastModeSupport,
          ],
        ),
      ),
  );
  return (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId?: string,
  ): boolean | undefined => {
    const policy = policies.get(normalizeProviderId(entry.provider));
    if (!policy || (evaluation.routeResolution !== null && !evaluation.selectedRoute)) {
      return undefined;
    }
    const route = evaluation.selectedRoute ?? entry;
    const { defaultParams, modelParams, agentModelParams, agentParams } =
      resolveModelExtraParamSources({
        config: params.cfg,
        provider: entry.provider,
        modelId: entry.id,
        agentId: params.agentId,
      });
    return policy({
      provider: entry.provider,
      modelId: entry.id,
      api: route.api,
      baseUrl: route.baseUrl,
      authMode: evaluation.selectedAuthMode,
      runtimeId: runtimeId ?? entry.nativeRuntime,
      modelParams: entry.params,
      params: Object.assign({}, defaultParams, modelParams, agentModelParams, agentParams),
      requestCapabilities: resolveProviderRequestCapabilities({
        provider: entry.provider,
        modelId: entry.id,
        api: route.api,
        baseUrl: route.baseUrl,
        providerMetadataOwners: params.metadataSnapshot.owners,
      }),
    });
  };
}
