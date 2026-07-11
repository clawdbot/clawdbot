/**
 * Prepares route-aware auth forwarding for auxiliary agent-runtime calls.
 * Callers supply an already loaded credential snapshot; this module never
 * resolves secrets or loads a provider runtime.
 */
import { resolveMergedModelProviderConfig } from "../../config/model-provider-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import type { ProviderRouteOverridePresence } from "../../plugin-sdk/provider-model-types.js";
import {
  resolveAuthProfileEligibility,
  resolveAuthProfileOrderWithMetadata,
} from "../auth-profiles/order.js";
import { resolveStoredCredentialReadOnlyAvailability } from "../auth-profiles/read-only-availability.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown } from "../auth-profiles/usage-state.js";
import { resolveProviderDirectAuthPlanningEvidence } from "../model-auth-env.js";
import {
  hasUsableCustomProviderApiKey,
  resolveProviderEntryApiKeyProfileReference,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../model-auth.js";
import { resolveOpenAIModelRoutes, selectOpenAIModelRouteAuth } from "../openai-model-routes.js";
import {
  buildProviderModelAuthDirectSource,
  buildProviderModelAuthSourcePlan,
  type ProviderModelAuthDirectSource,
  type ProviderModelAuthProfileSource,
} from "../provider-model-auth-source-plan.js";
import { selectProviderModelAuthSources } from "../provider-model-route-auth.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

type PrepareAgentRuntimeAuthPlanParams = {
  provider: string;
  modelId: string;
  modelApi?: string | null;
  modelBaseUrl?: unknown;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  authProfileStore?: AuthProfileStore;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user";
  harnessId?: string;
  harnessRuntime?: string;
  harnessAuthBootstrap?: "harness";
  allowHarnessAuthProfileForwarding?: boolean;
  allowTransientCooldownProbe?: boolean;
  resolveProviderPreferredProfileId?(context: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    preferredProfileId?: string;
    lockedProfileId?: string;
    profileOrder: string[];
    authStore: AuthProfileStore;
  }): string | undefined;
};

export type PreparedAgentRuntimeAuthAttempt =
  | {
      kind: "profile";
      plan: AgentRuntimeAuthPlan;
      profileId: string;
      allowAuthProfileFallback?: never;
      requiresPriorProfileAttempt?: never;
    }
  | {
      kind: "direct";
      plan: AgentRuntimeAuthPlan;
      profileId?: never;
      /** Direct lookup cannot re-enter automatic profile discovery. */
      allowAuthProfileFallback: false;
      /** Fail closed when every prepared profile became cooldown-blocked before dispatch. */
      requiresPriorProfileAttempt: boolean;
    }
  | {
      kind: "implicit";
      plan: AgentRuntimeAuthPlan;
      profileId?: never;
      allowAuthProfileFallback?: never;
      requiresPriorProfileAttempt?: never;
    };

export type PreparedAgentRuntimeAuth = {
  plan: AgentRuntimeAuthPlan;
  /** Ordered physical attempts; every route/profile tuple was selected by this planner. */
  attempts: readonly PreparedAgentRuntimeAuthAttempt[];
};

/** Prevents a direct fallback from bypassing a prepared profile tier. */
export function canRunPreparedAgentRuntimeAuthAttempt(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  priorProfileAttempted: boolean;
}): boolean {
  return (
    params.attempt.kind !== "direct" ||
    !params.attempt.requiresPriorProfileAttempt ||
    params.priorProfileAttempted
  );
}

/** Rechecks automatic cooldowns immediately before a prepared profile attempt. */
export function preparedAgentRuntimeProfileAttemptHasCandidate(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  store: AuthProfileStore;
  modelId: string;
}): boolean {
  if (params.attempt.kind !== "profile") {
    return false;
  }
  if (params.attempt.plan.forwardedAuthProfileSource === "user") {
    return true;
  }
  const profileIds = params.attempt.plan.forwardedAuthProfileCandidateIds ?? [
    params.attempt.profileId,
  ];
  return profileIds.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, undefined, params.modelId),
  );
}

/** True when a prepared auth tuple can be reused for this exact compaction target. */
export function agentRuntimeAuthPlanMatchesTarget(
  plan: AgentRuntimeAuthPlan,
  target: { provider: string; modelId: string },
): boolean {
  const route = plan.modelRoute;
  const provider = route?.provider ?? plan.providerForAuth;
  const modelId = route?.modelId ?? plan.modelId;
  return (
    modelId !== undefined &&
    provider.trim().toLowerCase() === target.provider.trim().toLowerCase() &&
    modelId === target.modelId
  );
}

function resolveProfile(
  params: PrepareAgentRuntimeAuthPlanParams,
  profileId: string,
  options: { ignoreCooldown?: boolean } = {},
): ProviderModelAuthProfileSource {
  const credential = params.authProfileStore?.profiles[profileId];
  const configured = params.config?.auth?.profiles?.[profileId];
  const availability = credential
    ? resolveStoredCredentialReadOnlyAvailability({
        credential,
        cfg: params.config ?? {},
        env: params.env ?? process.env,
      })
    : undefined;
  return {
    kind: "profile",
    profileId,
    provider: credential?.provider ?? configured?.provider,
    mode: credential?.type ?? configured?.mode,
    // Runtime materialization owns secret readiness; only proven-invalid facts are terminal here.
    readiness: availability === false ? "unavailable" : "unknown",
    cooldown:
      !options.ignoreCooldown &&
      params.authProfileStore &&
      isProfileInCooldown(params.authProfileStore, profileId, undefined, params.modelId)
        ? "active"
        : "clear",
  };
}

type ProviderEntryProfileParams = Pick<
  PrepareAgentRuntimeAuthPlanParams,
  "config" | "modelId" | "provider"
> & {
  store: AuthProfileStore;
};

/** Applies terminal provider-entry credential policy before route selection. */
function resolvePreparedProviderEntryApiKeyProfileReference(params: ProviderEntryProfileParams) {
  const reference = resolveProviderEntryApiKeyProfileReference({
    cfg: params.config,
    provider: params.provider,
    store: params.store,
  });
  if (reference.kind !== "profile") {
    return reference;
  }
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.config,
    store: params.store,
    provider: params.provider,
    profileId: reference.profileId,
  });
  if (!eligibility.eligible) {
    throw new Error(
      `Per-entry apiKey profile "${reference.profileId}" has no usable credentials for ${params.provider}.`,
    );
  }
  if (isProfileInCooldown(params.store, reference.profileId, undefined, params.modelId)) {
    throw new Error(
      `Auth profile "${reference.profileId}" is temporarily unavailable for ${params.provider}/${params.modelId}.`,
    );
  }
  return reference;
}

/** Selects concrete provider routes and ordered credentials as one immutable preparation. */
export function prepareAgentRuntimeAuth(
  params: PrepareAgentRuntimeAuthPlanParams,
): PreparedAgentRuntimeAuth {
  const requestedProfileId = params.sessionAuthProfileId?.trim() || undefined;
  const lockedProfileId =
    params.sessionAuthProfileSource === "user" ? requestedProfileId : undefined;
  const harnessOwnsOpenAIAuth =
    params.harnessId?.trim().toLowerCase() === "codex" ||
    params.harnessRuntime?.trim().toLowerCase() === "codex";
  const harnessAuthOwnerId = params.harnessId?.trim() || params.harnessRuntime?.trim();
  const runtimeAuthOwner =
    harnessOwnsOpenAIAuth && params.harnessAuthBootstrap === "harness" && harnessAuthOwnerId
      ? { id: harnessAuthOwnerId }
      : undefined;
  const harnessAllowsAuthProfileForwarding = params.allowHarnessAuthProfileForwarding !== false;
  if (lockedProfileId && !harnessAllowsAuthProfileForwarding) {
    throw new Error(
      `Auth profile "${lockedProfileId}" cannot be forwarded to the selected agent harness. Configure that harness's native account instead.`,
    );
  }
  const store = params.authProfileStore;
  const authProfileSelectionProvider = harnessOwnsOpenAIAuth ? "openai" : params.provider;
  if (lockedProfileId) {
    const eligibility = store
      ? resolveAuthProfileEligibility({
          cfg: params.config,
          store,
          provider: authProfileSelectionProvider,
          profileId: lockedProfileId,
        })
      : { eligible: false };
    if (!eligibility.eligible) {
      throw new Error(
        `Auth profile "${lockedProfileId}" is not configured for ${authProfileSelectionProvider}.`,
      );
    }
  }

  const configuredProvider = resolveMergedModelProviderConfig(params.config, params.provider);
  const configuredAuthMode =
    lockedProfileId || !harnessAllowsAuthProfileForwarding ? undefined : configuredProvider?.auth;
  const configuredAwsSdkAuth = configuredAuthMode === "aws-sdk";
  const providerHasApiKeySecretRef =
    harnessAllowsAuthProfileForwarding &&
    Boolean(coerceSecretRef(configuredProvider?.apiKey, params.config?.secrets?.defaults));
  const providerBinding =
    harnessAllowsAuthProfileForwarding && !lockedProfileId && store && !configuredAwsSdkAuth
      ? resolvePreparedProviderEntryApiKeyProfileReference({
          config: params.config,
          modelId: params.modelId,
          provider: params.provider,
          store,
        })
      : { kind: "none" as const };
  if (providerBinding.kind === "profile-incompatible") {
    throw new Error(
      `Per-entry apiKey "${providerBinding.profileId}" is not a compatible bearer profile for ${params.provider}.`,
    );
  }
  const boundProfileId = providerBinding.kind === "profile" ? providerBinding.profileId : undefined;
  const providerHasUsableMarker =
    providerBinding.kind === "marker" &&
    hasUsableCustomProviderApiKey(params.config, params.provider, params.env);
  const providerHasDirectMaterial =
    !configuredAwsSdkAuth &&
    (providerBinding.kind === "literal" || providerHasUsableMarker || providerHasApiKeySecretRef);
  const explicitConfigApiKeyAuth = shouldPreferExplicitConfigApiKeyAuth(
    params.config,
    params.provider,
  );
  const providerBindingSuppressesProfiles =
    (providerBinding.kind === "literal" && explicitConfigApiKeyAuth) ||
    providerHasUsableMarker ||
    (providerHasApiKeySecretRef && explicitConfigApiKeyAuth);
  const providerBindingNeedsNonProfileFallback =
    providerHasDirectMaterial && !providerBindingSuppressesProfiles;
  // Explicit auth owns the physical route; apiKey is only its bearer material.
  const selectedConfiguredAuthMode =
    configuredAuthMode ?? (providerHasDirectMaterial ? "api-key" : undefined);
  const selectedProfileId = lockedProfileId ?? boundProfileId;
  const automaticOrderResolution =
    !harnessAllowsAuthProfileForwarding ||
    selectedProfileId ||
    providerBindingSuppressesProfiles ||
    configuredAwsSdkAuth ||
    !store
      ? {
          profileIds: selectedProfileId ? [selectedProfileId] : [],
          hasExplicitOrder: false,
        }
      : resolveAuthProfileOrderWithMetadata({
          cfg: params.config,
          store,
          provider: authProfileSelectionProvider,
          preferredProfile: lockedProfileId ? undefined : requestedProfileId,
          forModel: params.modelId,
          readinessMode: "read-only",
        });
  const providerPreferredProfileId =
    harnessAllowsAuthProfileForwarding &&
    !selectedProfileId &&
    !providerBindingSuppressesProfiles &&
    !configuredAwsSdkAuth &&
    store
      ? params.resolveProviderPreferredProfileId?.({
          config: params.config,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          provider: params.provider,
          modelId: params.modelId,
          preferredProfileId: lockedProfileId ? undefined : requestedProfileId,
          lockedProfileId,
          profileOrder: automaticOrderResolution.profileIds,
          authStore: store,
        })
      : undefined;
  const resolvedOrderedProfileIds =
    providerPreferredProfileId &&
    automaticOrderResolution.profileIds.includes(providerPreferredProfileId)
      ? [
          providerPreferredProfileId,
          ...automaticOrderResolution.profileIds.filter(
            (profileId) => profileId !== providerPreferredProfileId,
          ),
        ]
      : automaticOrderResolution.profileIds;
  const directSource = (
    mode: string | undefined,
    evidence: ProviderModelAuthDirectSource["evidence"] = providerHasUsableMarker
      ? "runtime"
      : "provider-config",
    availability?: boolean,
  ) => buildProviderModelAuthDirectSource({ mode, evidence, availability });
  const directPlanningCandidate = harnessAllowsAuthProfileForwarding
    ? resolveProviderDirectAuthPlanningEvidence(
        authProfileSelectionProvider,
        params.env ?? process.env,
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
        },
      )
    : null;
  // OpenAI native account discovery is harness-owned synthetic auth, not a
  // bearer credential for an OpenClaw request route.
  const directPlanningEvidence =
    directPlanningCandidate?.kind === "setup-provider" &&
    authProfileSelectionProvider.trim().toLowerCase() === "openai"
      ? null
      : directPlanningCandidate;
  const directPlanningMode = directPlanningEvidence
    ? (configuredAuthMode ?? directPlanningEvidence.mode)
    : undefined;
  const fallbackDirectSource = directPlanningMode
    ? directSource(
        directPlanningMode,
        directPlanningEvidence?.kind === "environment" ? "environment" : "runtime",
        directPlanningEvidence?.kind === "environment" ? true : undefined,
      )
    : providerBindingNeedsNonProfileFallback
      ? directSource(selectedConfiguredAuthMode)
      : undefined;
  const automaticRouteAuthMode =
    fallbackDirectSource && configuredAuthMode && !providerBindingSuppressesProfiles
      ? undefined
      : selectedConfiguredAuthMode;
  const ownership = selectedProfileId
    ? {
        reason: lockedProfileId ? ("user-lock" as const) : ("provider-binding" as const),
        source: resolveProfile(params, selectedProfileId, { ignoreCooldown: true }),
      }
    : configuredAwsSdkAuth
      ? {
          reason: "configured-auth" as const,
          source: directSource("aws-sdk"),
        }
      : providerBindingSuppressesProfiles
        ? {
            reason: "configured-auth" as const,
            source: directSource(selectedConfiguredAuthMode),
          }
        : undefined;
  const sourcePlan = buildProviderModelAuthSourcePlan({
    ...(ownership ? { ownership } : {}),
    profiles: resolvedOrderedProfileIds.map((profileId) => resolveProfile(params, profileId)),
    ...(providerPreferredProfileId ? { preferredProfileId: providerPreferredProfileId } : {}),
    explicitOrder: automaticOrderResolution.hasExplicitOrder,
    ...(fallbackDirectSource ? { fallback: fallbackDirectSource } : {}),
    allowCooldown: params.allowTransientCooldownProbe,
  });
  const resolution = resolveOpenAIModelRoutes({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
    config: params.config,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  if (!resolution || resolution.kind === "indeterminate") {
    const sourceDecision = selectProviderModelAuthSources({
      provider: authProfileSelectionProvider,
      plan: sourcePlan,
    });
    if (sourceDecision.kind === "rejected") {
      if (sourceDecision.reason === "all-cooldown" && sourceDecision.source) {
        throw new Error(
          `Auth profile "${sourceDecision.source.profileId}" is temporarily unavailable for ${params.provider}/${params.modelId}.`,
        );
      }
      throw new Error(sourceDecision.message);
    }
    const buildGenericPlan = (
      attempt: (typeof sourceDecision.attempts)[number] | undefined,
      candidateIndex: number,
    ) => {
      const profile = attempt?.kind === "profile" ? attempt.source : undefined;
      const candidateIds = sourceDecision.attempts
        .slice(candidateIndex)
        .flatMap((candidate) => (candidate.kind === "profile" ? [candidate.source.profileId] : []));
      return buildAgentRuntimeAuthPlan({
        provider: params.provider,
        modelId: params.modelId,
        authProfileProvider: profile?.provider,
        authProfileMode:
          profile?.mode ??
          (attempt?.kind === "direct" ? attempt.source.mode : selectedConfiguredAuthMode),
        sessionAuthProfileId: profile?.profileId,
        sessionAuthProfileSource: profile
          ? sourcePlan.kind === "required" && sourcePlan.reason === "user-lock"
            ? "user"
            : "auto"
          : undefined,
        sessionAuthProfileCandidateIds: candidateIds.length > 0 ? candidateIds : undefined,
        config: params.config,
        workspaceDir: params.workspaceDir,
        harnessId: params.harnessId,
        harnessRuntime: params.harnessRuntime,
        allowHarnessAuthProfileForwarding: harnessAllowsAuthProfileForwarding,
      });
    };
    const attempts: PreparedAgentRuntimeAuthAttempt[] = sourceDecision.attempts.map(
      (attempt, index) => {
        const plan = buildGenericPlan(attempt, index);
        return attempt.kind === "profile"
          ? { kind: "profile", plan, profileId: attempt.source.profileId }
          : {
              kind: "direct",
              plan,
              allowAuthProfileFallback: attempt.allowAuthProfileFallback,
              requiresPriorProfileAttempt: sourceDecision.attempts
                .slice(0, index)
                .some((candidate) => candidate.kind === "profile"),
            };
      },
    );
    const plan = attempts[0]?.plan ?? buildGenericPlan(undefined, 0);
    if (
      selectedProfileId &&
      harnessOwnsOpenAIAuth &&
      plan.forwardedAuthProfileId !== selectedProfileId
    ) {
      throw new Error(
        `Auth profile "${selectedProfileId}" cannot be forwarded to the codex runtime.`,
      );
    }
    return {
      plan,
      attempts: attempts.length > 0 ? attempts : [{ kind: "implicit", plan }],
    };
  }
  if (resolution.kind === "incompatible") {
    throw new Error(resolution.message);
  }
  const toPreparedRoute = (route: (typeof resolution.routes)[number]) => ({
    provider: params.provider,
    modelId: params.modelId,
    api: route.api,
    baseUrl: route.baseUrl,
    authRequirement: route.authRequirement,
    requestTransportOverrides: route.requestTransportOverrides,
    runtimePolicy: route.runtimePolicy,
  });
  const routeAuthDecision = selectOpenAIModelRouteAuth({
    resolution,
    sourcePlan,
    configuredAuthMode: automaticRouteAuthMode,
    ...(runtimeAuthOwner ? { runtimeAuthOwner } : {}),
  });
  if (routeAuthDecision.kind === "deferred") {
    const plan = buildAgentRuntimeAuthPlan({
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      harnessId: params.harnessId,
      harnessRuntime: params.harnessRuntime,
      allowHarnessAuthProfileForwarding: harnessAllowsAuthProfileForwarding,
      deferredRouteSupport: routeAuthDecision.routeSupport,
    });
    return { plan, attempts: [{ kind: "implicit", plan }] };
  }
  if (routeAuthDecision.kind !== "selected") {
    if (
      routeAuthDecision.kind === "rejected" &&
      routeAuthDecision.reason === "all-cooldown" &&
      routeAuthDecision.source
    ) {
      throw new Error(
        `Auth profile "${routeAuthDecision.source.profileId}" is temporarily unavailable for ${params.provider}/${params.modelId}.`,
      );
    }
    throw new Error(routeAuthDecision.message);
  }
  const buildRoutedPlan = (attempt: (typeof routeAuthDecision.attempts)[number] | undefined) => {
    const profile = attempt?.kind === "profile" ? attempt.source : undefined;
    const route = attempt?.route ?? routeAuthDecision.selection.route;
    return buildAgentRuntimeAuthPlan({
      provider: params.provider,
      modelId: params.modelId,
      authProfileProvider: profile?.provider,
      authProfileMode:
        profile?.mode ??
        (attempt?.kind === "direct" ? attempt.source.mode : selectedConfiguredAuthMode),
      sessionAuthProfileId: profile?.profileId,
      sessionAuthProfileSource: profile
        ? sourcePlan.kind === "required" && sourcePlan.reason === "user-lock"
          ? "user"
          : "auto"
        : undefined,
      sessionAuthProfileCandidateIds:
        attempt?.kind === "profile" ? [...attempt.sameRouteProfileIds] : undefined,
      modelRoute: toPreparedRoute(route),
      config: params.config,
      workspaceDir: params.workspaceDir,
      harnessId: params.harnessId,
      harnessRuntime: params.harnessRuntime,
      allowHarnessAuthProfileForwarding: harnessAllowsAuthProfileForwarding,
    });
  };
  const attempts: PreparedAgentRuntimeAuthAttempt[] = routeAuthDecision.attempts.map(
    (attempt, index) => {
      const plan = buildRoutedPlan(attempt);
      return attempt.kind === "profile"
        ? { kind: "profile", plan, profileId: attempt.source.profileId }
        : {
            kind: "direct",
            plan,
            allowAuthProfileFallback: attempt.allowAuthProfileFallback,
            requiresPriorProfileAttempt: routeAuthDecision.attempts
              .slice(0, index)
              .some((candidate) => candidate.kind === "profile"),
          };
    },
  );
  const plan = attempts[0]?.plan ?? buildRoutedPlan(undefined);
  for (const attempt of attempts) {
    if (
      attempt.profileId &&
      harnessOwnsOpenAIAuth &&
      attempt.plan.forwardedAuthProfileId !== attempt.profileId
    ) {
      throw new Error(
        `Auth profile "${attempt.profileId}" cannot be forwarded to the codex runtime.`,
      );
    }
  }
  return {
    plan,
    attempts: attempts.length > 0 ? attempts : [{ kind: "implicit", plan }],
  };
}

/** Returns the initial immutable plan for auxiliary consumers. */
export function prepareAgentRuntimeAuthPlan(
  params: PrepareAgentRuntimeAuthPlanParams,
): AgentRuntimeAuthPlan {
  return prepareAgentRuntimeAuth(params).plan;
}
