import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveExternalCliAuthScopeFromConfig } from "../../agents/auth-profiles/external-cli-scope.js";
import { materializePersonalAuthProfile } from "../../agents/auth-profiles/personal-profiles.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { createAgentHarnessCatalogEvaluator } from "../../agents/harness/model-catalog-readiness.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
} from "../../agents/model-auth-availability.js";
import { loadManifestModelCatalog } from "../../agents/model-catalog.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { dedupeModelCatalogEntries } from "../../agents/model-selection-shared.js";
import {
  createOpenAIModelRoutesResolver,
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import { isPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { listUserProfileAuthLinks } from "../../state/user-model-accounts.js";

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

function createModelsListAuthResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preparedSyntheticAuthComplete?: boolean;
  workspaceDir: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}): ModelAuthAvailabilityResolver {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  return createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    agentId: params.agentId,
    authStore: params.preparedAuthStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    metadataSnapshot: params.metadataSnapshot,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    preparedSyntheticAuthComplete: params.preparedSyntheticAuthComplete,
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

function createModelsListEntryEvaluator(params: {
  authResolver: ModelAuthAvailabilityResolver;
  providerOutcomes?: readonly ProviderCatalogOutcome[];
  preferredProfileId?: string;
  preferredProfilesByProvider?: ReadonlyMap<string, string>;
  pinnedProfileId?: string;
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
      const defaultProfileId = params.preferredProfilesByProvider?.get(
        normalizeProviderId(entry.provider),
      );
      const preferredProfileId = params.preferredProfileId ?? defaultProfileId;
      // New sessions capture personal defaults with the same strength as explicit account pins.
      const pinnedProfileId = params.pinnedProfileId ?? defaultProfileId;
      const resolved = params.authResolver.evaluateRuntimeModelAuth(entry.provider, {
        modelId: identity?.id ?? entry.id,
        ...(normalizeProviderId(entry.provider) === "openai"
          ? {}
          : { api: entry.api, baseUrl: entry.baseUrl }),
        ...(preferredProfileId ? { preferredProfileId } : {}),
        ...(pinnedProfileId ? { pinnedProfileId } : {}),
        observedRoutes: routeVariants.map((variant) => ({
          api: variant.api,
          baseUrl: variant.baseUrl,
        })),
      });
      const provider = normalizeProviderId(entry.provider);
      // Stored credentials prove presence, not acceptance. Apply the live rejection only to the
      // profile discovery tested; widening it would hide routes backed by another valid profile.
      return params.providerOutcomes?.some(
        (outcome) =>
          outcome.status === "auth-rejected" &&
          outcome.rejectionScope !== "catalog" &&
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

export type ModelsListAuthProjectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir?: string;
  snapshot: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preparedSyntheticAuthComplete?: boolean;
  requesterProfileId?: string;
  pluginRegistry?: PluginRegistry;
  observationConfig?: OpenClawConfig;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  isCurrent?: () => boolean;
};

/** Builds requester/session auth views without changing shared catalog or credential snapshots. */
export function createModelsListAuthProjection(params: ModelsListAuthProjectionParams) {
  // The Gateway owns one process-lifecycle plugin metadata snapshot. Carry it
  // through the whole projection so per-model normalization cannot rediscover it.
  const metadataSnapshot = params.metadataSnapshot;
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.cfg, params.agentId) ??
    resolveDefaultAgentWorkspaceDir();
  let authStore = params.preparedAuthStore;
  const preferredProfilesByProvider = new Map<string, string>();
  const personalProviders = new Set<string>();
  // A persisted session pin wins over the current viewer's links. Only these
  // explicit selections enter this private projection, never its shared owner.
  if (params.preferredProfileId && isUserModelAuthProfileId(params.preferredProfileId)) {
    authStore = materializePersonalAuthProfile(authStore, params.preferredProfileId);
    const provider = authStore.profiles[params.preferredProfileId]?.provider;
    if (provider) {
      personalProviders.add(normalizeProviderId(provider));
    }
  } else if (!params.preferredProfileId && params.requesterProfileId) {
    for (const link of listUserProfileAuthLinks(params.requesterProfileId)) {
      const selected = isUserModelAuthProfileId(link.authProfileId)
        ? materializePersonalAuthProfile(authStore, link.authProfileId)
        : authStore;
      const provider =
        selected.profiles[link.authProfileId]?.provider ??
        params.cfg.auth?.profiles?.[link.authProfileId]?.provider;
      if (!provider || normalizeProviderId(provider) !== link.provider) {
        continue;
      }
      authStore = selected;
      preferredProfilesByProvider.set(link.provider, link.authProfileId);
      if (isUserModelAuthProfileId(link.authProfileId)) {
        personalProviders.add(link.provider);
      }
    }
  }
  const personalStaticEntries = personalProviders.size
    ? [
        ...(params.snapshot.staticEntries ?? []),
        ...loadManifestModelCatalog({ config: params.cfg, metadataSnapshot }),
      ].filter((entry) => personalProviders.has(normalizeProviderId(entry.provider)))
    : [];
  const snapshot = personalStaticEntries.length
    ? {
        ...params.snapshot,
        entries: dedupeModelCatalogEntries([...params.snapshot.entries, ...personalStaticEntries]),
        routeVariants: [
          ...(params.snapshot.routeVariants.length
            ? params.snapshot.routeVariants
            : params.snapshot.entries),
          ...personalStaticEntries,
        ],
      }
    : params.snapshot;
  const nativeEvaluator = createAgentHarnessCatalogEvaluator({
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
    workspaceDir,
    preferredProfileId: params.preferredProfileId,
    pinnedProfileId: params.pinnedProfileId,
    pluginRegistry: params.pluginRegistry,
    isCurrent: params.isCurrent,
    observationConfig: params.observationConfig,
  });
  // A selected profile is host-owned auth, not evidence from the shared native
  // login; the harness evaluator already applies this rule to session pins.
  const evaluateNative: typeof nativeEvaluator = (entry, host) =>
    preferredProfilesByProvider.has(normalizeProviderId(entry.provider))
      ? host
      : nativeEvaluator(entry, host);
  // Store revisions do not advance when a token or failure window expires.
  // Retire the captured host evaluation so its caller prepares fresh facts.
  const preparedAt = Date.now();
  const authValidUntil = Math.min(
    ...[
      ...Object.values(authStore.profiles).map((profile) =>
        profile.type === "token" ? profile.expires : undefined,
      ),
      ...Object.values(authStore.usageStats ?? {}).flatMap((stats) => [
        stats.blockedUntil,
        stats.cooldownUntil,
        stats.disabledUntil,
      ]),
    ].filter((deadline): deadline is number => deadline !== undefined && deadline > preparedAt),
  );
  const authResolver = createModelsListAuthResolver({
    cfg: params.cfg,
    agentId: params.agentId,
    metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    preparedSyntheticAuthComplete:
      params.preparedSyntheticAuthComplete ?? isPreparedModelCatalogFull(params.snapshot),
    workspaceDir,
    routeResolverFactory: params.routeResolverFactory,
  });
  const evaluateStoredEntry = createModelsListEntryEvaluator({
    authResolver,
    providerOutcomes: params.snapshot.providerOutcomes,
    preferredProfilesByProvider,
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.pinnedProfileId ? { pinnedProfileId: params.pinnedProfileId } : {}),
  });
  const missingPersonalPin = Boolean(
    params.preferredProfileId &&
    isUserModelAuthProfileId(params.preferredProfileId) &&
    !authStore.profiles[params.preferredProfileId],
  );
  const evaluateEntry: typeof evaluateStoredEntry = missingPersonalPin
    ? async () => ({
        availability: false,
        unavailableReason: "missing-auth",
        routeResolution: null,
      })
    : evaluateStoredEntry;
  return {
    evaluateEntry,
    evaluateNative,
    snapshot,
    metadataSnapshot,
    authStore,
    authModes: params.preparedRuntimeAuthModes,
    authMaterializations: params.preparedRuntimeAuthMaterializations,
    pluginRegistry: params.pluginRegistry,
    isCurrent: () =>
      Date.now() < authValidUntil &&
      (params.isCurrent?.() ?? params.observationConfig === undefined),
    observationConfig: params.observationConfig,
  };
}
