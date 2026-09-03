import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedProviderAuth } from "../../agents/agent-auth-credential-modes.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveExternalCliAuthScopeFromConfig } from "../../agents/auth-profiles/external-cli-scope.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  applyCliRuntimeModelAuthAvailability,
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
} from "../../agents/model-auth-availability.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";

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
  preparedProviderAuth?: PreparedProviderAuth;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preparedSyntheticAuthComplete?: boolean;
  workspaceDir: string;
}): ModelAuthAvailabilityResolver {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  return createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    authStore: params.preparedAuthStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    metadataSnapshot: params.metadataSnapshot,
    preparedProviderAuth: params.preparedProviderAuth,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    preparedSyntheticAuthComplete: params.preparedSyntheticAuthComplete,
    syntheticAuthProviderRefs: listEnabledSyntheticAuthProviderRefs(
      params.metadataSnapshot,
      params.cfg,
    ),
    externalCliProviderIds: resolveExternalCliAuthScopeFromConfig(params.cfg)?.providerIds ?? [],
    preparedRuntimeAuthStore: params.preparedAuthStore,
  });
}

export function createModelsListEntryEvaluator(params: {
  cfg: OpenClawConfig;
  agentId: string;
  authResolver: ModelAuthAvailabilityResolver;
  metadataSnapshot: PluginMetadataSnapshot;
  providerOutcomes?: readonly ProviderCatalogOutcome[];
  preferredProfileId?: string;
  lockedProfileId?: string;
}): (
  entry: ModelCatalogEntry,
  routeVariants?: readonly ModelCatalogEntry[],
) => Promise<ModelAuthAvailabilityEvaluation> {
  const pending = new Map<string, Promise<ModelAuthAvailabilityEvaluation>>();
  return (entry, routeVariants = [entry]) => {
    const identity = openAIModelCatalogRoutePolicy.resolveIdentity(entry);
    const cacheKey = resolveModelCatalogIdentityKey(entry);
    const cached = pending.get(cacheKey);
    if (cached) {
      return cached;
    }
    const next = Promise.resolve().then((): ModelAuthAvailabilityEvaluation => {
      const evaluation = params.authResolver.evaluateModelAuth(entry.provider, {
        modelId: identity?.id ?? entry.id,
        ...(normalizeProviderId(entry.provider) === "openai"
          ? {}
          : { api: entry.api, baseUrl: entry.baseUrl }),
        ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
        ...(params.lockedProfileId ? { lockedProfileId: params.lockedProfileId } : {}),
        observedRoutes: routeVariants.map((variant) => ({
          api: variant.api,
          baseUrl: variant.baseUrl,
        })),
      });
      const resolved = applyCliRuntimeModelAuthAvailability({
        authResolver: params.authResolver,
        evaluation,
        cfg: params.cfg,
        metadataSnapshot: params.metadataSnapshot,
        provider: entry.provider,
      });
      const provider = normalizeProviderId(entry.provider);
      // Stored credentials prove presence, not acceptance. Apply the live rejection only to the
      // profile discovery tested; widening it would hide routes backed by another valid profile.
      return params.providerOutcomes?.some(
        (outcome) =>
          outcome.status === "auth-rejected" &&
          outcome.rejectionScope !== "catalog" &&
          resolved.evidence !== "runtime" &&
          normalizeProviderId(outcome.provider) === provider &&
          (outcome.profileId === undefined || outcome.profileId === resolved.selectedProfileId),
      )
        ? {
            ...resolved,
            availability: false,
            unavailableReason: "auth-failed",
            unavailableUntil: undefined,
          }
        : resolved;
    });
    pending.set(cacheKey, next);
    return next;
  };
}
