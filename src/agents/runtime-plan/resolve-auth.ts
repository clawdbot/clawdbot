/** Resolves credentials for an immutable prepared runtime route. */
import { toErrorObject } from "../../infra/errors.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown } from "../auth-profiles/usage-state.js";
import { getApiKeyForModel } from "../model-auth.js";
import { providerModelRouteAcceptsAuthMode } from "../provider-model-route-auth.js";
import { shouldForceDirectAuthFallbackModelResolve } from "./credential-scoped-model.js";
import { sameAgentRuntimeAuthModelRoute } from "./model-route.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  preparedAgentRuntimeProfileAttemptHasCandidate,
  type PreparedAgentRuntimeAuthAttempt,
} from "./prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

type PreparedRuntimeModelAuthResolution = Readonly<{
  auth: Awaited<ReturnType<typeof getApiKeyForModel>>;
  plan: AgentRuntimeAuthPlan;
}>;

type PreparedRuntimeAuthAttemptResolution<Model, Auth> = Readonly<{
  model: Model;
  plan: AgentRuntimeAuthPlan;
  auth: Auth;
}>;

function listDistinctPreparedRuntimeAuthAttempts(
  attempts: readonly PreparedAgentRuntimeAuthAttempt[],
): PreparedAgentRuntimeAuthAttempt[] {
  return attempts.filter((attempt, index) => {
    const route = attempt.plan.modelRoute;
    return !attempts.slice(0, index).some((previous) => {
      // Same-route profile candidates resolve as one tier. Direct auth remains
      // distinct because it must never be swallowed by profile fallback.
      if (
        (previous.allowAuthProfileFallback === false) !==
        (attempt.allowAuthProfileFallback === false)
      ) {
        return false;
      }
      const previousRoute = previous.plan.modelRoute;
      if (!route || !previousRoute) {
        return !route && !previousRoute;
      }
      return sameAgentRuntimeAuthModelRoute(route, previousRoute);
    });
  });
}

/** Resolves one complete prepared route/profile tuple without crossing retries mid-flight. */
export async function resolvePreparedRuntimeAuthAttempts<Model, Auth>(params: {
  attempts: readonly PreparedAgentRuntimeAuthAttempt[];
  store: AuthProfileStore;
  modelId: string;
  model: Model;
  materializeModel(input: {
    plan: AgentRuntimeAuthPlan;
    model: Model;
    forceResolve?: boolean;
  }): Promise<Model>;
  resolveAuth(input: {
    attempt: PreparedAgentRuntimeAuthAttempt;
    model: Model;
  }): Promise<{ plan: AgentRuntimeAuthPlan; auth: Auth }>;
  forceCredentialScopedDirectModelResolve?: boolean;
  errorMessage: string;
}): Promise<PreparedRuntimeAuthAttemptResolution<Model, Auth>> {
  let firstError: unknown;
  let priorProfileAttempted = false;
  for (const attempt of listDistinctPreparedRuntimeAuthAttempts(params.attempts)) {
    if (
      !canRunPreparedAgentRuntimeAuthAttempt({
        attempt,
        priorProfileAttempted,
      })
    ) {
      firstError ??= new Error("Prepared direct auth cannot bypass unavailable profiles.");
      continue;
    }
    if (
      attempt.kind === "profile" &&
      !preparedAgentRuntimeProfileAttemptHasCandidate({
        attempt,
        store: params.store,
        modelId: params.modelId,
      })
    ) {
      firstError ??= new Error("Prepared runtime auth candidates are temporarily unavailable.");
      continue;
    }
    try {
      let model = await params.materializeModel({
        plan: attempt.plan,
        model: params.model,
        forceResolve:
          (params.forceCredentialScopedDirectModelResolve === true &&
            attempt.kind === "direct" &&
            Boolean(attempt.plan.selectedAuthMode)) ||
          shouldForceDirectAuthFallbackModelResolve({
            attempt,
            priorProfileAttempted,
          }),
      });
      if (
        attempt.kind === "profile" &&
        !preparedAgentRuntimeProfileAttemptHasCandidate({
          attempt,
          store: params.store,
          modelId: params.modelId,
        })
      ) {
        throw new Error("Prepared runtime auth candidates are temporarily unavailable.");
      }
      // Direct fallback unlocks only after credential resolution really ran;
      // cooldown skips and route-materialization failures do not count.
      const resolution = params.resolveAuth({ attempt, model });
      priorProfileAttempted ||= attempt.kind === "profile";
      const resolved = await resolution;
      if (resolved.plan.forwardedAuthProfileId !== attempt.plan.forwardedAuthProfileId) {
        model = await params.materializeModel({
          plan: resolved.plan,
          model,
          forceResolve: true,
        });
      }
      // Model, physical route, and credential become active together.
      return { model, plan: resolved.plan, auth: resolved.auth };
    } catch (error) {
      if (error instanceof SecretSurfaceUnavailableError) {
        throw error;
      }
      firstError ??= error;
    }
  }
  throw toErrorObject(firstError, params.errorMessage);
}

function scopeAuthStoreToPreparedCandidates(
  store: AuthProfileStore,
  profileIds: readonly string[],
): AuthProfileStore {
  const profileIdSet = new Set(profileIds);
  const profiles: AuthProfileStore["profiles"] = {};
  for (const profileId of profileIds) {
    const profile = store.profiles[profileId];
    if (profile) {
      profiles[profileId] = profile;
    }
  }
  const order = store.order
    ? Object.fromEntries(
        Object.entries(store.order).map(([provider, ids]) => [
          provider,
          ids.filter((profileId) => profileIdSet.has(profileId)),
        ]),
      )
    : undefined;
  const lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).filter(([, profileId]) => profileIdSet.has(profileId)),
      )
    : undefined;
  const usageStats = store.usageStats
    ? Object.fromEntries(
        Object.entries(store.usageStats).filter(([profileId]) => profileIdSet.has(profileId)),
      )
    : undefined;
  const runtimePersistedProfileIds = store.runtimePersistedProfileIds?.filter((profileId) =>
    profileIdSet.has(profileId),
  );
  const runtimeExternalProfileIds = store.runtimeExternalProfileIds?.filter((profileId) =>
    profileIdSet.has(profileId),
  );
  return {
    version: store.version,
    profiles,
    ...(order ? { order } : {}),
    ...(lastGood ? { lastGood } : {}),
    ...(usageStats ? { usageStats } : {}),
    ...(runtimePersistedProfileIds ? { runtimePersistedProfileIds } : {}),
    ...(runtimeExternalProfileIds || store.runtimeExternalProfileIdsAuthoritative === true
      ? {
          runtimeExternalProfileIds: runtimeExternalProfileIds ?? [],
          ...(store.runtimeExternalProfileIdsAuthoritative === true
            ? { runtimeExternalProfileIdsAuthoritative: true }
            : {}),
        }
      : {}),
  };
}

/** Restricts a native auth consumer to the profiles selected for one physical route. */
export function scopeAuthProfileStoreToPreparedPlan(
  store: AuthProfileStore,
  plan: AgentRuntimeAuthPlan,
): AuthProfileStore {
  const profileIds =
    plan.modelRoute?.authRequirement === "api-key"
      ? []
      : [plan.forwardedAuthProfileId, ...(plan.forwardedAuthProfileCandidateIds ?? [])].filter(
          (profileId, index, values): profileId is string => {
            return Boolean(profileId?.trim()) && values.indexOf(profileId) === index;
          },
        );
  return scopeAuthStoreToPreparedCandidates(store, profileIds);
}

function applyResolvedAuthToPlan(params: {
  plan: AgentRuntimeAuthPlan;
  auth: Awaited<ReturnType<typeof getApiKeyForModel>>;
  candidates: string[];
}): AgentRuntimeAuthPlan {
  const profileId = params.auth.profileId?.trim();
  if (!profileId) {
    return {
      ...params.plan,
      forwardedAuthProfileId: undefined,
      forwardedAuthProfileSource: undefined,
      forwardedAuthProfileCandidateIds: undefined,
      selectedAuthMode: params.auth.mode,
    };
  }
  const resolvedIndex = params.candidates.indexOf(profileId);
  const remainingCandidates =
    resolvedIndex >= 0 ? params.candidates.slice(resolvedIndex) : [profileId];
  const source = params.plan.forwardedAuthProfileId
    ? params.plan.forwardedAuthProfileSource
    : "auto";
  return {
    ...params.plan,
    forwardedAuthProfileId: profileId,
    forwardedAuthProfileSource: source,
    forwardedAuthProfileCandidateIds: source === "auto" ? remainingCandidates : [profileId],
    selectedAuthMode: params.auth.mode,
  };
}

function assertResolvedAuthMatchesPreparedRoute(params: {
  plan: AgentRuntimeAuthPlan;
  auth: Awaited<ReturnType<typeof getApiKeyForModel>>;
}): void {
  const route = params.plan.modelRoute;
  if (
    !route ||
    providerModelRouteAcceptsAuthMode({
      requirement: route.authRequirement,
      mode: params.auth.mode,
    })
  ) {
    return;
  }
  throw new Error(
    `Resolved ${params.auth.mode} credentials are incompatible with the selected ${route.authRequirement} route for ${route.provider}.`,
  );
}

/** Resolves prepared same-route candidates without pinning the first unresolved profile. */
export async function resolvePreparedRuntimeModelAuth(
  params: Omit<Parameters<typeof getApiKeyForModel>[0], "profileId"> & {
    plan: AgentRuntimeAuthPlan;
  },
): Promise<PreparedRuntimeModelAuthResolution> {
  const { plan, ...authParams } = params;
  const candidates = [
    plan.forwardedAuthProfileId,
    ...(plan.forwardedAuthProfileCandidateIds ?? []),
  ].filter((profileId, index, values): profileId is string => {
    return Boolean(profileId?.trim()) && values.indexOf(profileId) === index;
  });
  if (candidates.length === 0) {
    // The planner selected direct auth. Resolve only env/config material so an
    // unrelated full store cannot replace or pre-reject that immutable source.
    const auth = await getApiKeyForModel({
      ...authParams,
      store: { version: 1, profiles: {} },
      lockedProfile: false,
      allowAuthProfileFallback: false,
      skipSetupProviderFallback: plan.modelRoute?.provider === "openai",
    });
    assertResolvedAuthMatchesPreparedRoute({ plan, auth });
    return { auth, plan: applyResolvedAuthToPlan({ plan, auth, candidates }) };
  }
  if (plan.forwardedAuthProfileSource !== "auto") {
    const auth = await getApiKeyForModel({
      ...authParams,
      profileId: plan.forwardedAuthProfileId,
      lockedProfile: Boolean(plan.forwardedAuthProfileId),
    });
    assertResolvedAuthMatchesPreparedRoute({ plan, auth });
    return { auth, plan: applyResolvedAuthToPlan({ plan, auth, candidates }) };
  }

  // Prepared automatic candidates remain exhaustive, but their cooldown state
  // can change while work waits in a command lane. Recheck at credential use.
  const store = params.store;
  const currentCandidates = store
    ? candidates.filter(
        (profileId) => !isProfileInCooldown(store, profileId, undefined, params.model.id),
      )
    : candidates;
  if (currentCandidates.length === 0) {
    throw new Error("Prepared runtime auth candidates are temporarily unavailable.");
  }
  const candidateStore = store
    ? scopeAuthStoreToPreparedCandidates(store, currentCandidates)
    : undefined;

  let firstError: unknown;
  for (const profileId of currentCandidates) {
    try {
      const auth = await getApiKeyForModel({
        ...authParams,
        profileId,
        // This loop owns fallback order. Pin each lookup so the generic auth
        // resolver cannot rescan or skip across the prepared candidate set.
        lockedProfile: true,
        ...(candidateStore ? { store: candidateStore } : {}),
      });
      assertResolvedAuthMatchesPreparedRoute({ plan, auth });
      return {
        auth,
        plan: applyResolvedAuthToPlan({ plan, auth, candidates: currentCandidates }),
      };
    } catch (error) {
      if (error instanceof SecretSurfaceUnavailableError) {
        throw error;
      }
      firstError ??= error;
    }
  }
  throw toErrorObject(firstError, "Prepared runtime auth candidates could not be resolved.");
}
