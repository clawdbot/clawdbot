import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import type { RuntimeProviderAuthLookup } from "./model-auth.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedProviderAuthState } from "./model-provider-auth-state.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { normalizeProviderId } from "./model-selection.js";

export function buildDefaultModelRouteAuthEvidence(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  runtimeAuthLookup: RuntimeProviderAuthLookup;
  metadataSnapshot: PluginMetadataSnapshot;
  modelCatalog: ModelCatalogSnapshot;
}): PreparedProviderAuthState["defaultModelRoute"] {
  const model = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    allowPluginNormalization: true,
    manifestPlugins: params.metadataSnapshot.plugins,
  });
  const entry = findModelInCatalog(params.modelCatalog.entries, model.provider, model.model);
  if (!entry) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(entry.provider);
  const normalizedModelId = entry.id.trim().toLowerCase();
  const evaluation = createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore: params.authStore,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.metadataSnapshot,
    skipSetupProviderFallback: true,
    syntheticAuthProviderRefs: params.runtimeAuthLookup.syntheticAuthProviderRefs,
  }).evaluateModelAuth(entry.provider, {
    modelId: entry.id,
    api: entry.api,
    baseUrl: entry.baseUrl,
    observedRoutes: params.modelCatalog.routeVariants
      .filter(
        (route) =>
          normalizeProviderId(route.provider) === normalizedProvider &&
          route.id.trim().toLowerCase() === normalizedModelId,
      )
      .map((route) => ({ api: route.api, baseUrl: route.baseUrl })),
  });
  return evaluation.availability === undefined ||
    (!evaluation.availability &&
      params.runtimeAuthLookup.syntheticAuthProviderRefsComplete === false)
    ? undefined
    : {
        provider: normalizedProvider,
        modelId: normalizedModelId,
        available: evaluation.availability,
      };
}
