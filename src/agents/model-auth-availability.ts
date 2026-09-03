/** Read-only provider/model auth availability with provider-route selection. */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "@openclaw/model-catalog-core/provider-id";
import { hasNonEmptyString as hasSecret } from "@openclaw/normalization-core/string-coerce";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type {
  ProviderModelRouteAuthRequirement,
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
  ProviderModelRouteSource,
} from "../plugin-sdk/provider-model-types.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import type { PreparedProviderAuth } from "./agent-auth-credential-modes.js";
import { hasUsableOAuthCredential } from "./auth-profiles/credential-state.js";
import {
  listExternalCliSyncProviderIds,
  resolveExternalCliAuthProfiles,
} from "./auth-profiles/external-cli-sync.js";
import {
  type AuthProfileOrderResolution,
  isConfiguredAwsSdkAuthProfileForProvider,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrderWithMetadata,
} from "./auth-profiles/order.js";
import {
  hasMalformedSecretInputSyntax,
  resolveSecretRefReadOnlyAvailability,
  resolveStoredCredentialReadOnlyAvailability,
} from "./auth-profiles/read-only-availability.js";
import { getRuntimeExternalCliProfileIds } from "./auth-profiles/runtime-external-profile-references.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import { getRuntimeAuthProfileStoreSnapshotCore } from "./auth-profiles/runtime-snapshots.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  ProfileUsageStats,
} from "./auth-profiles/types.js";
import {
  isActiveUnusableWindow,
  isAuthCooldownBypassedForProvider,
  isProfileInCooldown,
  resolveProfileUnusableUntil,
} from "./auth-profiles/usage-state.js";
import { resolveInlineProviderApiKeyUsageId } from "./auth-profiles/usage.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps,
} from "./model-auth-env-vars.js";
import { resolveProviderEnvAuthEvidence } from "./model-auth-env.js";
import { isSecretRefHeaderValueMarker } from "./model-auth-markers.js";
import {
  hasSyntheticLocalProviderAuthConfig,
  hasUsableCustomProviderApiKey,
  resolveProviderConfigSecretInput,
  resolveProviderEntryApiKeyProfileReference,
  shouldPreferExplicitConfigApiKeyAuth,
} from "./model-auth-provider-config.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "./model-auth-runtime-config.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  createOpenAIModelRoutesResolver,
  resolveConfiguredOpenAIAuthMode,
  selectOpenAIModelRouteAuth,
} from "./openai-model-routes.js";
import {
  buildProviderModelAuthDirectSource,
  buildProviderModelAuthSourcePlan,
  fromProviderModelAuthReadiness,
  toProviderModelAuthReadiness,
  type ProviderModelAuthEvidence,
  type ProviderModelAuthProfileSource,
  type ProviderModelAuthSourcePlan,
} from "./provider-model-auth-source-plan.js";
import {
  resolveProviderModelRouteAuthRequirement,
  selectProviderModelAuthSources,
  type ProviderModelAuthSourceSelection,
} from "./provider-model-route-auth.js";
import { modelMatchesProviderModelRoute } from "./provider-model-route.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_RESPONSES_API = "openai-chatgpt-responses";
const EXTERNAL_CLI_REFRESH_PROVIDER_IDS = new Set(
  listExternalCliSyncProviderIds().map(normalizeProviderIdForAuth),
);

type ModelAuthAvailability = boolean | undefined;
type ModelAuthAvailabilityEvidence = Exclude<ProviderModelAuthEvidence, "none">;
export type ModelAuthAvailabilityRef = {
  modelId?: string;
  api?: string | null;
  baseUrl?: unknown;
  /** All physical route rows observed for this logical provider/model pair. */
  observedRoutes?: readonly ProviderModelRouteSource[];
  /** Automatic session preference; considered before the configured profile order. */
  preferredProfileId?: string;
  /** Explicit user/session lock; model-id suffixes are transport identity only. */
  lockedProfileId?: string;
};
export type ModelAuthAvailabilityEvaluation = {
  availability: ModelAuthAvailability;
  unavailableReason?: "missing-auth" | "auth-failed" | "cooldown";
  /** Earliest known retry time, in milliseconds since the Unix epoch. */
  unavailableUntil?: number;
  routeResolution: ProviderModelRouteResolution | null;
  selectedRoute?: ProviderModelRouteCandidate;
  selectedProfileId?: string;
  selectedAuthMode?: string;
  evidence?: ModelAuthAvailabilityEvidence;
};
export type ModelAuthAvailabilityResolver = {
  providerDiscoveryProviderIds: readonly string[];
  preparedSyntheticAuthComplete: boolean;
  resolvePreparedRuntimeAuthMode(provider: string): PreparedProviderAuth[string] | undefined;
  evaluateModelAuth(
    provider: string,
    ref?: ModelAuthAvailabilityRef,
  ): ModelAuthAvailabilityEvaluation;
  resolveProviderAuthAvailability(
    provider: string,
    ref?: ModelAuthAvailabilityRef,
  ): ModelAuthAvailability;
  hasSyntheticAuth(provider: string): boolean;
};

export function applyCliRuntimeModelAuthAvailability(params: {
  authResolver: ModelAuthAvailabilityResolver;
  evaluation: ModelAuthAvailabilityEvaluation;
  cfg: OpenClawConfig;
  metadataSnapshot?: PluginMetadataSnapshot;
  provider: string;
}): ModelAuthAvailabilityEvaluation {
  if (params.evaluation.routeResolution !== null) {
    return params.evaluation;
  }
  const preparedAuth = params.authResolver.resolvePreparedRuntimeAuthMode(params.provider);
  const runtimeProvider = preparedAuth?.runtime;
  if (
    !runtimeProvider ||
    normalizeProviderId(runtimeProvider) === normalizeProviderId(params.provider)
  ) {
    return params.evaluation;
  }
  const runtimeOwners = params.metadataSnapshot?.owners?.cliBackends.get(
    normalizeProviderId(runtimeProvider),
  );
  if (runtimeOwners?.length) {
    const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
    if (
      !runtimeOwners.some((pluginId) =>
        passesManifestOwnerBasePolicy({
          plugin: { id: pluginId },
          normalizedConfig: normalizedPluginConfig,
        }),
      )
    ) {
      return {
        ...params.evaluation,
        availability: false,
        unavailableReason: "missing-auth",
        unavailableUntil: undefined,
      };
    }
  }
  const runtimeAuth = preparedAuth;
  // The prepared native-runtime result is authoritative for this route. Provider
  // credentials cannot prove that the separately authenticated CLI is usable.
  return runtimeAuth
    ? {
        availability: true,
        routeResolution: null,
        selectedAuthMode: runtimeAuth.mode,
        evidence: "runtime",
      }
    : params.authResolver.preparedSyntheticAuthComplete
      ? { availability: false, routeResolution: null, unavailableReason: "missing-auth" }
      : { availability: undefined, routeResolution: null };
}
type CreateModelAuthAvailabilityResolverParams = {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
  externalCliProviderIds?: readonly string[];
  allowPreparedRuntimeAuth?: boolean;
  preparedRuntimeAuthStore?: AuthProfileStore;
  preparedProviderAuth?: PreparedProviderAuth;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preparedSyntheticAuthComplete?: boolean;
};

type AuthTarget = ModelAuthAvailabilityRef & {
  authRequirement?: ProviderModelRouteAuthRequirement;
};
type AuthSourceEvaluation = Pick<
  ModelAuthAvailabilityEvaluation,
  | "availability"
  | "selectedAuthMode"
  | "evidence"
  | "selectedProfileId"
  | "unavailableReason"
  | "unavailableUntil"
>;

function modeAllowed(provider: string, target: AuthTarget, mode: string | undefined): boolean {
  const requirement = resolveProviderModelRouteAuthRequirement(mode);
  return target.authRequirement
    ? requirement === target.authRequirement
    : provider !== OPENAI_PROVIDER_ID ||
        target.api === undefined ||
        target.api === OPENAI_CODEX_RESPONSES_API ||
        requirement === "api-key";
}

function normalizeModelIdForProvider(provider: string, modelId: string): string | undefined {
  const trimmed = splitTrailingAuthProfile(modelId).model.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return trimmed;
  }
  return normalizeProviderIdForAuth(trimmed.slice(0, slash)) === provider
    ? trimmed.slice(slash + 1).trim() || undefined
    : undefined;
}

/** Builds one snapshot-scoped read-only auth evaluator. */
export function createModelAuthAvailabilityResolver(
  params: CreateModelAuthAvailabilityResolverParams,
): ModelAuthAvailabilityResolver {
  const env = params.env ?? process.env;
  const now = Date.now();
  const isExternalCliProvider = (provider: string) =>
    EXTERNAL_CLI_REFRESH_PROVIDER_IDS.has(normalizeProviderIdForAuth(provider));
  const externalCliProviderIds = (params.externalCliProviderIds ?? []).filter(
    isExternalCliProvider,
  );
  const external = externalCliProviderIds.length
    ? resolveExternalCliAuthProfiles(params.authStore, {
        allowKeychainPrompt: false,
        providerIds: externalCliProviderIds,
      })
    : [];
  const store: AuthProfileStore = external.length
    ? {
        ...params.authStore,
        profiles: {
          ...params.authStore.profiles,
          ...Object.fromEntries(external.map((item) => [item.profileId, item.credential])),
        },
      }
    : params.authStore;
  const runtimeStore =
    params.preparedRuntimeAuthStore ??
    (params.allowPreparedRuntimeAuth !== false
      ? getRuntimeAuthProfileStoreSnapshotCore(params.agentDir)
      : undefined);
  const hydratedProfileIds = new Set<string>();
  const sameSecretRef = (
    left: ReturnType<typeof coerceSecretRef>,
    right: ReturnType<typeof coerceSecretRef>,
  ) =>
    left !== null &&
    right !== null &&
    left.source === right.source &&
    left.provider === right.provider &&
    left.id === right.id;
  const runtimeCredentialOverlay = (
    profileId: string,
    credential: AuthProfileCredential,
  ): AuthProfileCredential => {
    const runtime = runtimeStore?.profiles[profileId];
    if (!runtime || credential.type !== runtime.type || credential.provider !== runtime.provider) {
      return credential;
    }
    // The snapshot key plus profile id and provider/type establish runtime ownership.
    // Only ref-only stubs bootstrap; inline persisted OAuth remains authoritative.
    if (
      credential.type === "oauth" &&
      runtime.type === "oauth" &&
      credential.oauthRef &&
      !hasSecret(credential.access) &&
      !hasSecret(credential.refresh) &&
      hasUsableOAuthCredential(runtime, { now })
    ) {
      return runtime;
    }
    if (
      credential.type === "api_key" &&
      runtime.type === "api_key" &&
      sameSecretRef(
        coerceSecretRef(credential.keyRef ?? credential.key, params.cfg.secrets?.defaults),
        coerceSecretRef(runtime.keyRef, params.cfg.secrets?.defaults),
      ) &&
      hasSecret(runtime.key)
    ) {
      hydratedProfileIds.add(profileId);
      return { ...credential, key: runtime.key };
    }
    if (
      credential.type === "token" &&
      runtime.type === "token" &&
      sameSecretRef(
        coerceSecretRef(credential.tokenRef ?? credential.token, params.cfg.secrets?.defaults),
        coerceSecretRef(runtime.tokenRef, params.cfg.secrets?.defaults),
      ) &&
      hasSecret(runtime.token)
    ) {
      hydratedProfileIds.add(profileId);
      return { ...credential, token: runtime.token };
    }
    return credential;
  };
  const orderProfiles = runtimeStore
    ? Object.fromEntries(
        Object.entries(store.profiles).map(([profileId, credential]) => [
          profileId,
          runtimeCredentialOverlay(profileId, credential),
        ]),
      )
    : store.profiles;
  const orderBaseStore =
    orderProfiles === store.profiles ? store : { ...store, profiles: orderProfiles };
  const orderStore: AuthProfileStore = orderBaseStore.usageStats
    ? {
        ...orderBaseStore,
        usageStats: Object.fromEntries(
          Object.entries(orderBaseStore.usageStats).map(([id, stats]) => [id, { ...stats }]),
        ),
      }
    : orderBaseStore;
  const { aliasMap, envCandidateMap, authEvidenceMap } = resolveProviderEnvAuthLookupMaps({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env,
    metadataSnapshot: params.metadataSnapshot,
  });
  const synthetic = new Set(
    (params.syntheticAuthProviderRefs ?? []).map(normalizeProviderIdForAuth),
  );
  const resolveRoutes = createOpenAIModelRoutesResolver({ config: params.cfg, env });
  const envCache = new Map<string, ReturnType<typeof resolveProviderEnvAuthEvidence>>();
  const orderCache = new Map<string, AuthProfileOrderResolution>();
  const normalizeProvider = (provider: string) => {
    const normalized = normalizeProviderIdForAuth(provider);
    return aliasMap[normalized] ?? normalized;
  };
  // Refresh authority follows exact profiles marked by the external-auth
  // lifecycle. Provider-wide authority could bless an unrelated stale profile.
  const externalCliRefreshProfileIds = new Set([
    ...external.map((profile) => profile.profileId),
    ...getRuntimeExternalCliProfileIds(runtimeStore ?? store),
  ]);
  const readOnlyAuthConfig = params.cfg;
  const providerInput = (provider: string) =>
    resolveProviderConfigSecretInput(params.cfg, provider);
  const prepareAuthTarget = (provider: string, ref: ModelAuthAvailabilityRef): AuthTarget => {
    const { providerConfig: configured } = providerInput(provider);
    const configuredModelId = ref.modelId
      ? normalizeModelIdForProvider(provider, ref.modelId)
      : undefined;
    const configuredModel = configuredModelId
      ? configured?.models?.find(
          (model) => normalizeModelIdForProvider(provider, model.id) === configuredModelId,
        )
      : undefined;
    return {
      ...ref,
      api: ref.api ?? configuredModel?.api ?? configured?.api,
      baseUrl: ref.baseUrl ?? configuredModel?.baseUrl ?? configured?.baseUrl,
    };
  };
  const providerBinding = (provider: string) =>
    resolveProviderEntryApiKeyProfileReference({
      cfg: params.cfg,
      provider,
      store,
    });
  const envAuth = (provider: string) => {
    const normalized = normalizeProvider(provider);
    if (!envCache.has(normalized)) {
      envCache.set(
        normalized,
        resolveProviderEnvAuthEvidence(normalized, env, {
          aliasMap,
          candidateMap: envCandidateMap,
          authEvidenceMap,
          config: params.cfg,
          workspaceDir: params.workspaceDir,
        }),
      );
    }
    return envCache.get(normalized);
  };
  const profileOrder = (
    provider: string,
    forModel?: string,
    preferredProfileId?: string,
    lockedProfileId?: string,
  ) => {
    const normalized = normalizeProvider(provider);
    const cacheKey = `${normalized}\u0000${forModel ?? ""}\u0000${preferredProfileId ?? ""}\u0000${lockedProfileId ?? ""}`;
    const cached = orderCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const resolution = resolveAuthProfileOrderWithMetadata({
      cfg: readOnlyAuthConfig,
      store: orderStore,
      provider: normalized,
      preferredProfile: preferredProfileId,
      forModel,
      readinessMode: "read-only",
    });
    orderCache.set(cacheKey, resolution);
    return resolution;
  };
  const profileMode = (profileId: string) =>
    store.profiles[profileId]?.type ?? params.cfg.auth?.profiles?.[profileId]?.mode;
  const profileCredential = (
    profileId: string,
    credential = store.profiles[profileId],
  ): AuthProfileCredential | undefined => {
    return credential ? runtimeCredentialOverlay(profileId, credential) : undefined;
  };
  const profileEligibleForReadOnlyAvailability = (
    provider: string,
    profileId: string,
    credential: AuthProfileCredential,
  ) => {
    const effectiveStore =
      store.profiles[profileId] === credential
        ? store
        : { ...store, profiles: { ...store.profiles, [profileId]: credential } };
    const eligibility = resolveAuthProfileEligibility({
      cfg: readOnlyAuthConfig,
      store: effectiveStore,
      provider: normalizeProvider(provider),
      profileId,
      now,
    });
    // Runtime execution still rejects unresolved refs. Browse/status keeps them
    // structurally eligible so the read-only credential classifier can return unknown.
    return eligibility.eligible || eligibility.reasonCode === "unresolved_ref";
  };
  const credentialAvailability = (
    provider: string,
    profileId: string,
    credential: AuthProfileCredential,
    target: AuthTarget,
  ): ModelAuthAvailability => {
    if (!modeAllowed(provider, target, credential.type)) {
      return false;
    }
    return resolveStoredCredentialReadOnlyAvailability({
      credential,
      cfg: params.cfg,
      env,
      now,
      canRefreshOAuth:
        provider === OPENAI_PROVIDER_ID || externalCliRefreshProfileIds.has(profileId),
    });
  };
  const resolvedProfileAvailability = (
    provider: string,
    profileId: string,
    credential: AuthProfileCredential,
    target: AuthTarget,
  ) => {
    if (!hydratedProfileIds.has(profileId)) {
      return credentialAvailability(provider, profileId, credential, target);
    }
    if (!modeAllowed(provider, target, credential.type)) {
      return false;
    }
    return (
      credential.type !== "token" || credential.expires === undefined || credential.expires > now
    );
  };
  const profileInCooldown = (profileId: string, target: AuthTarget) => {
    const cooldownModel = target.modelId
      ? splitTrailingAuthProfile(target.modelId).model
      : undefined;
    return isProfileInCooldown(store, profileId, now, cooldownModel);
  };
  const hasPermanentAuthFailure = (stats: ProfileUsageStats | undefined) =>
    stats?.disabledReason === "auth_permanent" && isActiveUnusableWindow(stats.disabledUntil, now);
  const profileAvailability = (
    provider: string,
    profileId: string,
    target: AuthTarget,
    allowCooldown = false,
  ): ModelAuthAvailability => {
    if (!allowCooldown && profileInCooldown(profileId, target)) {
      return false;
    }
    if (isConfiguredAwsSdkAuthProfileForProvider({ cfg: params.cfg, provider, profileId })) {
      return modeAllowed(provider, target, "aws-sdk");
    }
    const credential = profileCredential(profileId);
    if (!credential || !profileEligibleForReadOnlyAvailability(provider, profileId, credential)) {
      return false;
    }
    return resolvedProfileAvailability(provider, profileId, credential, target);
  };
  const hasProfileEvidence = (provider: string) => {
    const normalized = normalizeProvider(provider);
    const configuredOrder = findNormalizedProviderValue(params.cfg.auth?.order, normalized);
    if (configuredOrder !== undefined) {
      return true;
    }
    if (
      Object.values(params.cfg.auth?.profiles ?? {}).some(
        (profile) => normalizeProvider(profile.provider) === normalized,
      )
    ) {
      return true;
    }
    return Object.keys(store.profiles).some((profileId) => {
      const reason = resolveAuthProfileEligibility({
        cfg: params.cfg,
        store,
        provider: normalized,
        profileId,
      }).reasonCode;
      return reason !== "provider_mismatch" && reason !== "profile_missing";
    });
  };
  const firstProfileEvidenceId = (provider: string): string | undefined => {
    const normalized = normalizeProvider(provider);
    const configuredOrder = findNormalizedProviderValue(params.cfg.auth?.order, normalized);
    const storedOrder = findNormalizedProviderValue(store.order, normalized);
    const candidates = configuredOrder ?? storedOrder ?? Object.keys(store.profiles);
    return candidates.find((profileId) => {
      const reason = resolveAuthProfileEligibility({
        cfg: params.cfg,
        store,
        provider: normalized,
        profileId,
      }).reasonCode;
      return reason !== "provider_mismatch" && reason !== "profile_missing";
    });
  };
  const unprofiledEvaluation = (provider: string, target: AuthTarget): AuthSourceEvaluation => {
    const { providerConfig: configured, ref: apiKeyRef } = providerInput(provider);
    if (configured?.auth === "aws-sdk") {
      return {
        availability: modeAllowed(provider, target, "aws-sdk"),
        selectedAuthMode: "aws-sdk",
        evidence: "aws-sdk",
      };
    }
    const apiKey = configured?.apiKey;
    const configuredBearerMode =
      configured?.auth === "api-key" || configured?.auth === "oauth" || configured?.auth === "token"
        ? configured.auth
        : "api-key";
    if (!apiKeyRef && hasMalformedSecretInputSyntax(apiKey)) {
      return { availability: false, evidence: "provider-config" };
    }
    const binding = providerBinding(provider);
    if (binding.kind === "profile") {
      const credential = profileCredential(binding.profileId, binding.credential);
      const cooldownModel = target.modelId
        ? splitTrailingAuthProfile(target.modelId).model
        : undefined;
      const availability =
        credential &&
        !isProfileInCooldown(store, binding.profileId, now, cooldownModel) &&
        profileEligibleForReadOnlyAvailability(
          binding.credential.provider,
          binding.profileId,
          credential,
        )
          ? resolvedProfileAvailability(provider, binding.profileId, credential, target)
          : false;
      return {
        availability,
        selectedProfileId: binding.profileId,
        selectedAuthMode: credential?.type ?? binding.credential.type,
        evidence: "profile",
      };
    }
    if (binding.kind === "profile-incompatible") {
      return { availability: false, evidence: "profile" };
    }
    // Config-backed inline provider keys have no auth profile, so a recorded
    // billing/auth cooldown must hide them from browse availability the same way
    // it blocks their resolution — otherwise a cooled key still looks usable.
    const inlineUsageStats = isAuthCooldownBypassedForProvider(provider)
      ? undefined
      : store.usageStats?.[resolveInlineProviderApiKeyUsageId(provider)];
    const inlineKeyUnusableUntil = inlineUsageStats
      ? resolveProfileUnusableUntil(inlineUsageStats)
      : null;
    if (inlineKeyUnusableUntil != null && inlineKeyUnusableUntil > now) {
      return {
        availability: false,
        evidence: "provider-config",
        ...(hasPermanentAuthFailure(inlineUsageStats)
          ? { unavailableReason: "auth-failed" as const }
          : { unavailableReason: "cooldown" as const, unavailableUntil: inlineKeyUnusableUntil }),
      };
    }
    if (binding.kind === "literal") {
      return {
        availability: modeAllowed(provider, target, configuredBearerMode),
        selectedAuthMode: configuredBearerMode,
        evidence: "provider-config",
      };
    }
    if (binding.kind === "marker") {
      if (binding.evidence === "environment" && typeof apiKey === "string") {
        return {
          availability: modeAllowed(provider, target, configuredBearerMode)
            ? hasSecret(env[apiKey.trim()])
            : false,
          selectedAuthMode: configuredBearerMode,
          evidence: "environment",
        };
      }
      if (!modeAllowed(provider, target, configuredBearerMode)) {
        return {
          availability: false,
          selectedAuthMode: configuredBearerMode,
          evidence: binding.evidence,
        };
      }
      if (hasUsableCustomProviderApiKey(params.cfg, provider, env)) {
        return {
          availability: true,
          selectedAuthMode: configuredBearerMode,
          evidence: binding.evidence,
        };
      }
      const managed = typeof apiKey === "string" && isSecretRefHeaderValueMarker(apiKey);
      return {
        availability: managed
          ? Boolean(resolveManagedSecretRefRuntimeProviderAuth({ provider, cfg: params.cfg })) ||
            undefined
          : undefined,
        selectedAuthMode: configuredBearerMode,
        evidence: managed ? "runtime" : binding.evidence,
      };
    }
    if (apiKeyRef) {
      if (!isValidSecretRef(apiKeyRef) || !modeAllowed(provider, target, configuredBearerMode)) {
        return {
          availability: false,
          selectedAuthMode: configuredBearerMode,
          evidence: "provider-config",
        };
      }
      const available = resolveSecretRefReadOnlyAvailability(apiKeyRef, params.cfg, env);
      const runtimeAvailable = Boolean(
        resolveManagedSecretRefRuntimeProviderAuth({ provider, cfg: params.cfg }),
      );
      return {
        availability: runtimeAvailable ? true : available,
        selectedAuthMode: configuredBearerMode,
        evidence: runtimeAvailable ? "runtime" : "provider-config",
      };
    }
    if (apiKey !== undefined && !(typeof apiKey === "string" && apiKey.trim() === "")) {
      return { availability: false, evidence: "provider-config" };
    }
    if (
      provider === "amazon-bedrock" &&
      (target.api === undefined || target.api === "bedrock-converse-stream") &&
      configured?.auth === undefined &&
      apiKey === undefined
    ) {
      return {
        availability: modeAllowed(provider, target, "aws-sdk"),
        selectedAuthMode: "aws-sdk",
        evidence: "aws-sdk",
      };
    }
    const preparedProviderAuth =
      params.preparedProviderAuth?.[normalizeProviderIdForAuth(provider)];
    if (preparedProviderAuth) {
      return {
        availability: modeAllowed(provider, target, preparedProviderAuth.mode),
        selectedAuthMode: preparedProviderAuth.mode,
        evidence: "runtime",
      };
    }
    const environment = envAuth(provider);
    if (environment) {
      if (provider === "amazon-bedrock" && environment.mode === "aws-sdk") {
        return {
          availability: modeAllowed(provider, target, "aws-sdk"),
          selectedAuthMode: "aws-sdk",
          evidence: "aws-sdk",
        };
      }
      const mode = configured?.auth ?? environment.mode;
      return {
        availability: modeAllowed(provider, target, mode),
        selectedAuthMode: mode,
        evidence: "environment",
      };
    }
    const hasDeclaredSyntheticAuth =
      synthetic.has(normalizeProviderIdForAuth(provider)) ||
      synthetic.has(normalizeProvider(provider));
    if (
      hasSyntheticLocalProviderAuthConfig({
        cfg: params.cfg,
        provider,
        route: hasDeclaredSyntheticAuth ? target : undefined,
      })
    ) {
      return { availability: true, evidence: "synthetic" };
    }
    if (hasDeclaredSyntheticAuth) {
      return params.preparedSyntheticAuthComplete
        ? { availability: false, evidence: "synthetic", unavailableReason: "missing-auth" }
        : { availability: undefined, evidence: "synthetic" };
    }
    const hasAuthEvidence =
      configured?.auth !== undefined ||
      (apiKey !== undefined && !(typeof apiKey === "string" && apiKey.trim() === "")) ||
      hasProfileEvidence(provider);
    return {
      availability: hasAuthEvidence ? false : undefined,
      unavailableReason: hasAuthEvidence ? "auth-failed" : "missing-auth",
      selectedAuthMode: configured?.auth,
    };
  };
  const automaticProfileSource = (
    provider: string,
    profileId: string,
    target: AuthTarget,
  ): ProviderModelAuthProfileSource => ({
    kind: "profile",
    profileId,
    mode: profileMode(profileId),
    readiness: toProviderModelAuthReadiness(profileAvailability(provider, profileId, target, true)),
    cooldown: profileInCooldown(profileId, target) ? "active" : "clear",
  });
  const requiredProfileSource = (
    provider: string,
    profileId: string,
    target: AuthTarget,
    ignoreCooldown: boolean,
  ): ProviderModelAuthProfileSource => ({
    kind: "profile",
    profileId,
    mode: profileMode(profileId),
    readiness: toProviderModelAuthReadiness(
      profileAvailability(provider, profileId, target, ignoreCooldown),
    ),
    cooldown: "clear",
  });
  const cooldownEvaluation = (
    profiles: readonly ProviderModelAuthProfileSource[],
    target: AuthTarget,
  ): AuthSourceEvaluation => {
    // Selection rejects the entire cooling tier. Its first/preferred profile
    // need not recover first; invalid or permanently rejected credentials cannot supply a retry time.
    const model = target.modelId ? splitTrailingAuthProfile(target.modelId).model : undefined;
    const retryTimes = profiles.flatMap((profile) => {
      if (profile.readiness === "unavailable" || profile.cooldown !== "active") {
        return [];
      }
      const stats = store.usageStats?.[profile.profileId];
      const until =
        stats && !hasPermanentAuthFailure(stats) ? resolveProfileUnusableUntil(stats, model) : null;
      return until !== null && until > now ? [until] : [];
    });
    return {
      availability: false,
      unavailableReason: retryTimes.length ? "cooldown" : "auth-failed",
      ...(retryTimes.length ? { unavailableUntil: Math.min(...retryTimes) } : {}),
    };
  };
  const rejectedSourceEvaluation = (
    reason: "all-cooldown" | "configured-auth" | "explicit-order" | "required-profile",
    plan: ProviderModelAuthSourcePlan,
    target: AuthTarget,
  ): AuthSourceEvaluation =>
    reason === "all-cooldown" && plan.kind === "automatic"
      ? cooldownEvaluation(
          plan.orderedProfiles.filter(
            (profile) =>
              !target.authRequirement ||
              resolveProviderModelRouteAuthRequirement(profile.mode) === target.authRequirement,
          ),
          target,
        )
      : { availability: false, unavailableReason: "auth-failed" };
  const sourceEvaluation = (
    selection: ProviderModelAuthSourceSelection,
    provider: string,
    target: AuthTarget,
    directEvaluation: AuthSourceEvaluation,
  ): AuthSourceEvaluation => {
    if (selection.kind === "none") {
      return directEvaluation;
    }
    const source = selection.source;
    if (source.kind === "profile") {
      const availability =
        selection.kind === "unavailable" ? false : fromProviderModelAuthReadiness(source.readiness);
      const profile =
        availability === false
          ? automaticProfileSource(provider, source.profileId, target)
          : undefined;
      return {
        ...(availability === false
          ? profile && profile.readiness !== "unavailable" && profile.cooldown === "active"
            ? cooldownEvaluation([profile], target)
            : { availability, unavailableReason: "auth-failed" as const }
          : { availability }),
        selectedProfileId: source.profileId,
        selectedAuthMode: source.mode,
        evidence: "profile",
      };
    }
    // Direct policy adds retry times only for unavailable inline keys; unknown reasons stay hidden.
    const { unavailableReason, ...evaluation } = directEvaluation;
    return {
      ...evaluation,
      ...(source.readiness === "unavailable"
        ? { unavailableReason: unavailableReason ?? "auth-failed" }
        : {}),
      selectedAuthMode: source.mode,
    };
  };
  const directPolicy = (provider: string, target: AuthTarget) => {
    const { providerConfig: configured, ref: apiKeyRef } = providerInput(provider);
    const binding = providerBinding(provider);
    const markerUsable =
      binding.kind === "marker" && hasUsableCustomProviderApiKey(params.cfg, provider, env);
    const hasDirectMaterial = binding.kind === "literal" || markerUsable || apiKeyRef !== null;
    const required =
      configured?.auth === "aws-sdk" ||
      markerUsable ||
      (hasDirectMaterial && shouldPreferExplicitConfigApiKeyAuth(params.cfg, provider));
    const environment = envAuth(provider);
    const environmentMode = environment ? (configured?.auth ?? environment.mode) : undefined;
    const evaluation: AuthSourceEvaluation =
      !required && environmentMode
        ? {
            selectedAuthMode: environmentMode,
            availability: modeAllowed(provider, target, environmentMode),
            evidence: environmentMode === "aws-sdk" ? "aws-sdk" : "environment",
          }
        : unprofiledEvaluation(provider, target);
    const direct = buildProviderModelAuthDirectSource({
      mode: evaluation.selectedAuthMode,
      availability: evaluation.availability,
      evidence: evaluation.evidence ?? "none",
      // Match runtime-plan/prepare-auth.ts: only an environment credential
      // with no authored material is ambient, so browse cannot widen authority.
      authorization:
        evaluation.evidence === "environment" && !hasDirectMaterial ? "ambient" : "declared",
    });
    const hasDirectFallback = hasDirectMaterial || direct.evidence !== "none";
    return {
      binding,
      direct,
      evaluation,
      hasDirectMaterial,
      hasDirectFallback,
      markerUsable,
      required,
    };
  };
  const automaticSourceRejection = (
    provider: string,
    ref: ModelAuthAvailabilityRef,
    target: AuthTarget,
  ): AuthSourceEvaluation | undefined => {
    if (ref.lockedProfileId?.trim()) {
      return undefined;
    }
    const policy = directPolicy(provider, target);
    if (
      policy.required ||
      policy.binding.kind === "profile" ||
      policy.binding.kind === "profile-incompatible"
    ) {
      return undefined;
    }
    const orderResolution = profileOrder(
      provider,
      ref.modelId,
      ref.preferredProfileId,
      ref.lockedProfileId,
    );
    const plan = buildProviderModelAuthSourcePlan({
      profiles: orderResolution.profileIds.map((profileId) =>
        automaticProfileSource(provider, profileId, target),
      ),
      preferredProfileId: ref.preferredProfileId,
      explicitOrder: orderResolution.hasExplicitOrder,
      ...(policy.hasDirectFallback ? { fallback: policy.direct } : {}),
    });
    const decision = selectProviderModelAuthSources({ provider, plan });
    return decision.kind === "rejected"
      ? {
          ...rejectedSourceEvaluation(decision.reason, plan, target),
          evidence: "profile",
          ...(decision.source
            ? {
                selectedAuthMode: decision.source.mode,
                selectedProfileId: decision.source.profileId,
              }
            : {}),
        }
      : undefined;
  };
  const resolveProviderEvaluation = (
    rawProvider: string,
    ref: ModelAuthAvailabilityRef = {},
    preparedTarget?: AuthTarget,
  ): AuthSourceEvaluation => {
    const provider = normalizeProviderIdForAuth(rawProvider);
    const target = preparedTarget ?? prepareAuthTarget(provider, ref);
    const profileLock = ref.lockedProfileId?.trim();
    const policy = directPolicy(provider, target);
    if (!profileLock && policy.binding.kind === "profile-incompatible") {
      return { availability: false, unavailableReason: "auth-failed", evidence: "profile" };
    }
    const orderResolution = profileOrder(
      provider,
      ref.modelId,
      ref.preferredProfileId,
      ref.lockedProfileId,
    );
    const boundProfileId =
      !profileLock && policy.binding.kind === "profile" ? policy.binding.profileId : undefined;
    const ownership = profileLock
      ? {
          reason: "user-lock" as const,
          source: requiredProfileSource(provider, profileLock, target, true),
        }
      : boundProfileId
        ? {
            reason: "provider-binding" as const,
            source: requiredProfileSource(provider, boundProfileId, target, false),
          }
        : policy.required
          ? { reason: "configured-auth" as const, source: policy.direct }
          : undefined;
    const sourcePlan = buildProviderModelAuthSourcePlan({
      ...(ownership ? { ownership } : {}),
      profiles: orderResolution.profileIds.map((profileId) =>
        automaticProfileSource(provider, profileId, target),
      ),
      preferredProfileId: ref.preferredProfileId,
      explicitOrder: orderResolution.hasExplicitOrder,
      ...(policy.hasDirectFallback ? { fallback: policy.direct } : {}),
    });
    const decision = selectProviderModelAuthSources({ provider, plan: sourcePlan });
    if (decision.kind === "rejected") {
      return {
        ...rejectedSourceEvaluation(decision.reason, sourcePlan, target),
        ...(decision.source
          ? {
              selectedProfileId: decision.source.profileId,
              selectedAuthMode: decision.source.mode,
            }
          : {}),
        evidence: "profile",
      };
    }
    return sourceEvaluation(decision.selection, provider, target, policy.evaluation);
  };
  // Provider-only availability is the legacy fallback when no route artifact exists;
  // it never claims a concrete OpenAI endpoint.
  const resolveProviderAuthAvailability = (provider: string, ref: ModelAuthAvailabilityRef = {}) =>
    resolveProviderEvaluation(provider, ref).availability;
  const evaluateModelAuth = (
    rawProvider: string,
    ref: ModelAuthAvailabilityRef = {},
  ): ModelAuthAvailabilityEvaluation => {
    const provider = normalizeProviderIdForAuth(rawProvider);
    if (provider !== OPENAI_PROVIDER_ID) {
      return {
        ...resolveProviderEvaluation(provider, ref),
        routeResolution: null,
      };
    }
    const routeResolution = resolveRoutes(ref);
    if (!routeResolution) {
      // Provider policy owns route validation. Null preserves the legacy fallback
      // signal without rebuilding a partial OpenAI policy in core.
      return { availability: undefined, routeResolution: null };
    }
    if (routeResolution.kind === "incompatible") {
      return { availability: false, routeResolution };
    }
    if (routeResolution.kind === "indeterminate") {
      const rejection = automaticSourceRejection(provider, ref, prepareAuthTarget(provider, ref));
      return { ...(rejection ?? { availability: undefined }), routeResolution };
    }
    const modelLock = ref.lockedProfileId?.trim();
    const configuredAuthMode = resolveConfiguredOpenAIAuthMode(params.cfg);
    const awsSdkTerminal = !modelLock && configuredAuthMode === "aws-sdk";
    const baseTarget = prepareAuthTarget(provider, ref);
    const basePolicy = directPolicy(provider, baseTarget);
    if (!modelLock && !awsSdkTerminal && basePolicy.binding.kind === "profile-incompatible") {
      return { availability: false, unavailableReason: "auth-failed", routeResolution };
    }
    const bindingProfileId =
      !modelLock && !awsSdkTerminal && basePolicy.binding.kind === "profile"
        ? basePolicy.binding.profileId
        : undefined;
    const orderResolution = profileOrder(
      provider,
      ref.modelId,
      ref.preferredProfileId,
      ref.lockedProfileId,
    );
    const materializedModelId = ref.modelId
      ? normalizeModelIdForProvider(provider, ref.modelId)?.toLowerCase()
      : undefined;
    const materialized =
      !modelLock && !bindingProfileId && !basePolicy.required && materializedModelId
        ? params.preparedRuntimeAuthMaterializations?.find(
            (fact) =>
              // Explicit order remains authoritative: runtime success only satisfies it
              // when the producer names a profile still admitted by the current order.
              (!orderResolution.hasExplicitOrder ||
                (fact.authProfileId !== undefined &&
                  orderResolution.profileIds.includes(fact.authProfileId))) &&
              normalizeProvider(fact.provider) === provider &&
              fact.modelId === materializedModelId &&
              routeResolution.routes.some((route) => {
                const configuredRequirement =
                  resolveProviderModelRouteAuthRequirement(configuredAuthMode);
                return (
                  (!configuredRequirement || configuredRequirement === route.authRequirement) &&
                  route.runtimePolicy?.compatibleIds.some(
                    (runtimeId) => runtimeId.trim().toLowerCase() === fact.runtimeOwnerId,
                  ) === true &&
                  route.api.toLowerCase() === fact.modelApi &&
                  route.requestTransportOverrides === fact.requestTransportOverrides &&
                  modelMatchesProviderModelRoute({
                    provider,
                    api: fact.modelApi,
                    baseUrl: fact.modelBaseUrl,
                    route,
                  }) &&
                  modeAllowed(
                    provider,
                    {
                      ...ref,
                      api: route.api,
                      baseUrl: route.baseUrl,
                      authRequirement: route.authRequirement,
                    },
                    fact.authMode,
                  )
                );
              }),
          )
        : undefined;
    if (materialized) {
      const selectedRoute = routeResolution.routes.find(
        (route) =>
          route.runtimePolicy?.compatibleIds.some(
            (runtimeId) => runtimeId.trim().toLowerCase() === materialized.runtimeOwnerId,
          ) === true &&
          route.api.toLowerCase() === materialized.modelApi &&
          route.requestTransportOverrides === materialized.requestTransportOverrides &&
          modelMatchesProviderModelRoute({
            provider,
            api: materialized.modelApi,
            baseUrl: materialized.modelBaseUrl,
            route,
          }),
      );
      if (selectedRoute) {
        return {
          availability: true,
          routeResolution,
          selectedRoute,
          selectedAuthMode: materialized.authMode,
          ...(materialized.authProfileId ? { selectedProfileId: materialized.authProfileId } : {}),
          evidence: "runtime",
        };
      }
    }
    const selectedConfiguredMode = awsSdkTerminal
      ? "aws-sdk"
      : bindingProfileId
        ? undefined
        : (configuredAuthMode ?? (basePolicy.hasDirectMaterial ? "api-key" : undefined));
    const automaticRouteAuthMode =
      basePolicy.hasDirectFallback && configuredAuthMode && !basePolicy.required
        ? undefined
        : selectedConfiguredMode;
    const targetForMode = (mode: string | undefined): AuthTarget => {
      const requirement = resolveProviderModelRouteAuthRequirement(mode);
      const route = requirement
        ? routeResolution.routes.find((candidate) => candidate.authRequirement === requirement)
        : undefined;
      return route
        ? {
            ...ref,
            api: route.api,
            baseUrl: route.baseUrl,
            authRequirement: route.authRequirement,
          }
        : baseTarget;
    };
    const policy = directPolicy(
      provider,
      targetForMode(selectedConfiguredMode ?? basePolicy.direct.mode),
    );
    let profileIds = orderResolution.profileIds;
    if (profileIds.length === 0 && !modelLock && !bindingProfileId && !policy.required) {
      const evidenceProfileId = firstProfileEvidenceId(provider);
      if (evidenceProfileId) {
        profileIds = [evidenceProfileId];
      }
    }
    const ownership = modelLock
      ? {
          reason: "user-lock" as const,
          source: requiredProfileSource(
            provider,
            modelLock,
            targetForMode(profileMode(modelLock)),
            true,
          ),
        }
      : bindingProfileId
        ? {
            reason: "provider-binding" as const,
            source: requiredProfileSource(
              provider,
              bindingProfileId,
              targetForMode(profileMode(bindingProfileId)),
              false,
            ),
          }
        : policy.required
          ? { reason: "configured-auth" as const, source: policy.direct }
          : undefined;
    const sourcePlan = buildProviderModelAuthSourcePlan({
      ...(ownership ? { ownership } : {}),
      profiles: profileIds.map((profileId) =>
        automaticProfileSource(provider, profileId, targetForMode(profileMode(profileId))),
      ),
      preferredProfileId: ref.preferredProfileId,
      explicitOrder: orderResolution.hasExplicitOrder,
      ...(policy.hasDirectFallback ? { fallback: policy.direct } : {}),
    });
    const nativeAuthRuntime =
      !modelLock &&
      !selectedConfiguredMode &&
      (policy.binding.kind === "none" ||
        (policy.binding.kind === "marker" && !policy.markerUsable)) &&
      sourcePlan.kind === "automatic" &&
      !sourcePlan.profiles.explicitOrder &&
      (sourcePlan.profiles.kind === "empty" || sourcePlan.profiles.kind === "all-unavailable")
        ? params.preparedProviderAuth?.[provider]?.runtime
        : undefined;
    const nativeAuthOwnsRoute =
      nativeAuthRuntime !== undefined &&
      routeResolution.routes.every((route) =>
        route.runtimePolicy?.compatibleIds?.some(
          (runtimeId) => runtimeId.trim().toLowerCase() === nativeAuthRuntime.trim().toLowerCase(),
        ),
      );
    const routeAuthDecision = selectOpenAIModelRouteAuth({
      resolution: routeResolution,
      sourcePlan,
      configuredAuthMode: automaticRouteAuthMode,
      ...(nativeAuthOwnsRoute ? { runtimeAuthOwner: { id: nativeAuthRuntime } } : {}),
      ...(nativeAuthOwnsRoute &&
      resolveMergedModelProviderConfig(params.cfg, provider) === undefined
        ? { allowNativeAuthOnSingleRoute: true }
        : {}),
    });
    if (routeAuthDecision.kind === "deferred" && nativeAuthOwnsRoute) {
      return { availability: true, routeResolution, evidence: "runtime" };
    }
    if (routeAuthDecision.kind !== "selected") {
      const rejectedSource =
        routeAuthDecision.kind === "rejected" ? routeAuthDecision.source : undefined;
      const projectRejectedSource =
        routeAuthDecision.kind === "rejected" &&
        rejectedSource &&
        (routeAuthDecision.reason === "all-cooldown" || rejectedSource.readiness === "unavailable")
          ? rejectedSource
          : undefined;
      const rejectedRequirement = resolveProviderModelRouteAuthRequirement(rejectedSource?.mode);
      const rejectedRoute =
        routeAuthDecision.kind === "rejected" ? routeAuthDecision.route : undefined;
      const rejectedSourceRoute = rejectedRequirement
        ? routeResolution.routes.find(
            (candidate) => candidate.authRequirement === rejectedRequirement,
          )
        : undefined;
      const selectedRoute =
        rejectedRoute ??
        rejectedSourceRoute ??
        (routeResolution.routes.length === 1 ? routeResolution.routes[0] : undefined);
      return {
        ...(routeAuthDecision.kind === "rejected"
          ? rejectedSourceEvaluation(routeAuthDecision.reason, sourcePlan, {
              ...ref,
              authRequirement:
                rejectedRoute?.authRequirement ??
                (routeResolution.routes.length === 1 ? selectedRoute?.authRequirement : undefined),
            })
          : { availability: false }),
        ...(sourcePlan.kind === "automatic" &&
        sourcePlan.profiles.kind === "empty" &&
        !sourcePlan.profiles.explicitOrder &&
        !policy.hasDirectFallback
          ? { unavailableReason: policy.evaluation.unavailableReason }
          : {}),
        routeResolution,
        ...(projectRejectedSource
          ? {
              selectedProfileId: projectRejectedSource.profileId,
              selectedAuthMode: projectRejectedSource.mode,
              evidence: "profile" as const,
            }
          : {}),
        ...(selectedRoute ? { selectedRoute } : {}),
      };
    }
    const selectedRoute = routeAuthDecision.selection.route;
    const evaluation = sourceEvaluation(
      routeAuthDecision.selection,
      provider,
      { ...ref, ...selectedRoute },
      policy.evaluation,
    );
    return {
      ...evaluation,
      availability:
        evaluation.availability === undefined && !evaluation.evidence
          ? false
          : evaluation.availability,
      routeResolution,
      selectedRoute,
    };
  };
  const providerDiscoveryProviderIds = new Set<string>();
  const addProviderDiscoveryProviderId = (provider: string | undefined) => {
    if (!provider) {
      return;
    }
    const normalized = normalizeProvider(provider);
    if (normalized) {
      providerDiscoveryProviderIds.add(normalized);
    }
  };
  for (const credential of Object.values(store.profiles)) {
    addProviderDiscoveryProviderId(credential.provider);
  }
  for (const profile of Object.values(params.cfg.auth?.profiles ?? {})) {
    addProviderDiscoveryProviderId(profile.provider);
  }
  for (const provider of listProviderEnvAuthLookupKeys({ envCandidateMap, authEvidenceMap })) {
    if (envAuth(provider)) {
      addProviderDiscoveryProviderId(provider);
    }
  }
  for (const plugin of params.metadataSnapshot?.index?.plugins ?? []) {
    if (
      !plugin.enabled ||
      !(plugin.syntheticAuthRefs ?? []).some((ref) =>
        synthetic.has(normalizeProviderIdForAuth(ref)),
      )
    ) {
      continue;
    }
    for (const provider of [
      ...(plugin.contributions?.providers ?? []),
      ...(plugin.contributions?.modelCatalogProviders ?? []),
    ]) {
      addProviderDiscoveryProviderId(provider);
    }
  }
  return {
    providerDiscoveryProviderIds: [...providerDiscoveryProviderIds].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    preparedSyntheticAuthComplete: params.preparedSyntheticAuthComplete === true,
    evaluateModelAuth,
    resolvePreparedRuntimeAuthMode: (provider) =>
      params.preparedProviderAuth?.[normalizeProviderIdForAuth(provider)],
    resolveProviderAuthAvailability,
    hasSyntheticAuth: (provider) =>
      synthetic.has(normalizeProviderIdForAuth(provider)) ||
      synthetic.has(normalizeProvider(provider)) ||
      hasSyntheticLocalProviderAuthConfig({
        cfg: params.cfg,
        provider: normalizeProviderIdForAuth(provider),
      }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
