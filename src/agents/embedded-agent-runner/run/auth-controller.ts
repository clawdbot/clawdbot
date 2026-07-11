/**
 * Coordinates provider auth, profile rotation, and runtime auth refresh.
 */
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { Model } from "../../../llm/types.js";
import type { ProviderModelRouteAuthRequirement } from "../../../plugin-sdk/provider-model-types.js";
import { prepareProviderRuntimeAuth } from "../../../plugins/provider-runtime.js";
import {
  type AuthProfileStore,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  resolveSubscriptionAuthModeForProfiles,
} from "../../auth-profiles.js";
import { formatAuthProfileFailureMessage } from "../../auth-profiles/failure-copy.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  type FailoverReason,
} from "../../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { shouldUseTransientCooldownProbeSlot } from "../../failover-policy.js";
import {
  getApiKeyForModel,
  MissingProviderAuthError,
  type ResolvedProviderAuth,
} from "../../model-auth.js";
import { providerModelRouteAcceptsAuthMode } from "../../provider-model-route-auth.js";
import {
  applyPreparedRuntimeAuthToModel,
  type ModelProviderRequestTransportOverrides,
} from "../../provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "../../provider-secret-egress.js";
import { clampRuntimeAuthRefreshDelayMs } from "../../runtime-auth-refresh.js";
import {
  RUNTIME_AUTH_REFRESH_MARGIN_MS,
  RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
  RUNTIME_AUTH_REFRESH_RETRY_MS,
  type RuntimeAuthState,
} from "./helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type ApiKeyInfo = ResolvedProviderAuth;

type RuntimeApiKeySink = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
};

type LogLike = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

/** Decides whether one automatic profile may bypass its current cooldown. */
export function resolveEmbeddedAuthCooldownProbePolicy(params: {
  authStore: AuthProfileStore;
  profileCandidates: Array<string | undefined>;
  lockedProfileId?: string;
  modelId: string;
  allowTransientCooldownProbe: boolean;
}): { allowProbe: boolean; unavailableReason: FailoverReason | null } {
  const autoProfileCandidates = params.profileCandidates.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0 && candidate !== params.lockedProfileId,
  );
  const allAutoProfilesInCooldown =
    autoProfileCandidates.length > 0 &&
    autoProfileCandidates.every((candidate) =>
      isProfileInCooldown(params.authStore, candidate, undefined, params.modelId),
    );
  const unavailableReason = allAutoProfilesInCooldown
    ? (resolveProfilesUnavailableReason({
        store: params.authStore,
        profileIds: autoProfileCandidates,
      }) ?? "unknown")
    : null;
  return {
    allowProbe:
      params.allowTransientCooldownProbe &&
      allAutoProfilesInCooldown &&
      shouldUseTransientCooldownProbeSlot(unavailableReason),
    unavailableReason,
  };
}

/**
 * Coordinates auth profile selection, runtime auth preparation/refresh, and
 * profile failover for one embedded run. State is injected through accessors so
 * the runner can keep provider/model/auth snapshots in sync across retries.
 */
export function createEmbeddedRunAuthController(params: {
  config: RunEmbeddedAgentParams["config"];
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  authStorage: RuntimeApiKeySink;
  profileCandidates: Array<string | undefined>;
  lockedProfileId?: string;
  initialThinkLevel: ThinkLevel;
  attemptedThinking: Set<ThinkLevel>;
  fallbackConfigured: boolean;
  allowTransientCooldownProbe: boolean;
  getProvider(): string;
  getModelId(): string;
  getRuntimeModel(): Model;
  setRuntimeModel(next: Model): void;
  getEffectiveModel(): Model;
  setEffectiveModel(next: Model): void;
  getApiKeyInfo(): ApiKeyInfo | null;
  setApiKeyInfo(next: ApiKeyInfo | null): void;
  getLastProfileId(): string | undefined;
  setLastProfileId(next: string | undefined): void;
  getRuntimeAuthState(): RuntimeAuthState | null;
  setRuntimeAuthState(next: RuntimeAuthState | null): void;
  getRuntimeAuthRefreshCancelled(): boolean;
  setRuntimeAuthRefreshCancelled(next: boolean): void;
  getProfileIndex(): number;
  setProfileIndex(next: number): void;
  prepareModelForAuthProfile?(
    profileId: string | undefined,
    attemptIndex?: number,
  ): Promise<{
    runtimeModel: Model;
    authRequirement?: ProviderModelRouteAuthRequirement;
    allowAuthProfileFallback?: boolean;
    commit(): void;
  }>;
  setThinkLevel(next: ThinkLevel): void;
  log: LogLike;
}) {
  // Runtime auth overlays are profile-scoped. Keep the pre-auth model so a
  // later profile cannot inherit an earlier profile's endpoint or headers.
  const baseRuntimeModel = params.getRuntimeModel();
  const baseEffectiveModel = params.getEffectiveModel();

  const commitPreparedModel = (
    preparedModel:
      | Awaited<ReturnType<NonNullable<typeof params.prepareModelForAuthProfile>>>
      | undefined,
  ) => {
    preparedModel?.commit();
    if (preparedModel?.authRequirement) {
      return;
    }
    params.setRuntimeModel(baseRuntimeModel);
    params.setEffectiveModel(baseEffectiveModel);
  };

  const applyPreparedRuntimeRequestOverrides = (paramsForApply: {
    runtimeModel: Model;
    preparedAuth: {
      baseUrl?: string;
      request?: ModelProviderRequestTransportOverrides;
    };
  }): void => {
    const runtimeModel = applyPreparedRuntimeAuthToModel(
      paramsForApply.runtimeModel,
      paramsForApply.preparedAuth,
    );
    if (runtimeModel === paramsForApply.runtimeModel) {
      return;
    }
    // Runtime auth plugins may override baseUrl and safe request auth headers,
    // while the shared applier strips privileged transport knobs.
    params.setRuntimeModel(runtimeModel);
    params.setEffectiveModel(
      applyPreparedRuntimeAuthToModel(params.getEffectiveModel(), paramsForApply.preparedAuth),
    );
  };

  const hasRefreshableRuntimeAuth = () =>
    Boolean(params.getRuntimeAuthState()?.sourceApiKey.trim());

  const nextRuntimeAuthGeneration = () => (params.getRuntimeAuthState()?.generation ?? 0) + 1;

  const prepareRuntimeAuthForModel = async (prepareParams: {
    runtimeModel: Model;
    apiKey: string;
    authMode: string;
    profileId?: string;
  }) => {
    const preparedAuth = await prepareProviderRuntimeAuth({
      provider: prepareParams.runtimeModel.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: process.env,
      context: {
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        env: process.env,
        provider: prepareParams.runtimeModel.provider,
        modelId: params.getModelId(),
        model: prepareParams.runtimeModel,
        apiKey: unwrapSecretSentinelsForProviderEgress(
          prepareParams.apiKey,
          "provider runtime auth exchange",
        ),
        authMode: prepareParams.authMode,
        profileId: prepareParams.profileId,
      },
    });
    return protectPreparedProviderRuntimeAuth({
      provider: prepareParams.runtimeModel.provider,
      preparedAuth,
    });
  };

  const clearRuntimeAuthRefreshTimer = () => {
    const runtimeAuthState = params.getRuntimeAuthState();
    if (!runtimeAuthState?.refreshTimer) {
      return;
    }
    clearTimeout(runtimeAuthState.refreshTimer);
    runtimeAuthState.refreshTimer = undefined;
  };

  const stopRuntimeAuthRefreshTimer = () => {
    if (!params.getRuntimeAuthState()) {
      return;
    }
    params.setRuntimeAuthRefreshCancelled(true);
    clearRuntimeAuthRefreshTimer();
  };

  const refreshRuntimeAuth = async (reason: string): Promise<void> => {
    const runtimeAuthState = params.getRuntimeAuthState();
    if (!runtimeAuthState) {
      return;
    }
    if (runtimeAuthState.refreshInFlight) {
      await runtimeAuthState.refreshInFlight;
      return;
    }
    // Generation/profile/source checks below discard refreshes that complete
    // after another profile or credential has already become active.
    const refreshGeneration = runtimeAuthState.generation;
    const refreshProfileId = runtimeAuthState.profileId;
    const refreshPromise: Promise<void> = (async () => {
      const currentRuntimeAuthState = params.getRuntimeAuthState();
      const sourceApiKey = currentRuntimeAuthState?.sourceApiKey.trim() ?? "";
      if (!sourceApiKey) {
        throw new Error(`Runtime auth refresh requires a source credential.`);
      }
      const runtimeModel = params.getRuntimeModel();
      params.log.debug(`Refreshing runtime auth for ${runtimeModel.provider} (${reason})...`);
      const preparedAuth = await prepareRuntimeAuthForModel({
        runtimeModel,
        apiKey: sourceApiKey,
        authMode: currentRuntimeAuthState?.authMode ?? "unknown",
        profileId: currentRuntimeAuthState?.profileId,
      });
      if (!preparedAuth?.apiKey) {
        throw new Error(
          `Provider "${runtimeModel.provider}" does not support runtime auth refresh.`,
        );
      }
      const activeRuntimeAuthState = params.getRuntimeAuthState();
      if (
        !activeRuntimeAuthState ||
        activeRuntimeAuthState.generation !== refreshGeneration ||
        activeRuntimeAuthState.profileId !== refreshProfileId ||
        activeRuntimeAuthState.sourceApiKey.trim() !== sourceApiKey
      ) {
        params.log.debug(
          `Ignoring stale runtime auth refresh for ${runtimeModel.provider}; auth state advanced before ${reason} refresh completed.`,
        );
        return;
      }
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
      applyPreparedRuntimeRequestOverrides({ runtimeModel, preparedAuth });
      params.setRuntimeAuthState({
        ...activeRuntimeAuthState,
        expiresAt: preparedAuth.expiresAt,
      } as RuntimeAuthState);
      if (preparedAuth.expiresAt) {
        const remaining = preparedAuth.expiresAt - Date.now();
        params.log.debug(
          `Runtime auth refreshed for ${runtimeModel.provider}; expires in ${Math.max(0, Math.floor(remaining / 1000))}s.`,
        );
      }
    })()
      .catch((err: unknown) => {
        const runtimeModel = params.getRuntimeModel();
        params.log.warn(
          `Runtime auth refresh failed for ${runtimeModel.provider}: ${formatErrorMessage(err)}`,
        );
        throw err;
      })
      .finally(() => {
        const activeState = params.getRuntimeAuthState();
        if (
          activeState &&
          activeState.generation === refreshGeneration &&
          activeState.refreshInFlight === refreshPromise
        ) {
          activeState.refreshInFlight = undefined;
        }
      });
    runtimeAuthState.refreshInFlight = refreshPromise;
    await refreshPromise;
  };

  const scheduleRuntimeAuthRefresh = (): void => {
    const runtimeAuthState = params.getRuntimeAuthState();
    if (!runtimeAuthState || params.getRuntimeAuthRefreshCancelled()) {
      return;
    }
    const runtimeModel = params.getRuntimeModel();
    if (!hasRefreshableRuntimeAuth()) {
      params.log.warn(
        `Skipping runtime auth refresh scheduling for ${runtimeModel.provider}; source credential missing.`,
      );
      return;
    }
    if (!runtimeAuthState.expiresAt) {
      return;
    }
    clearRuntimeAuthRefreshTimer();
    const now = Date.now();
    const refreshAt = runtimeAuthState.expiresAt - RUNTIME_AUTH_REFRESH_MARGIN_MS;
    const delayMs = clampRuntimeAuthRefreshDelayMs({
      refreshAt,
      now,
      minDelayMs: RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
    });
    const timer = setTimeout(() => {
      if (params.getRuntimeAuthRefreshCancelled()) {
        return;
      }
      refreshRuntimeAuth("scheduled")
        .then(() => scheduleRuntimeAuthRefresh())
        .catch(() => {
          if (params.getRuntimeAuthRefreshCancelled()) {
            return;
          }
          const retryTimer = setTimeout(() => {
            if (params.getRuntimeAuthRefreshCancelled()) {
              return;
            }
            refreshRuntimeAuth("scheduled-retry")
              .then(() => scheduleRuntimeAuthRefresh())
              .catch(() => undefined);
          }, RUNTIME_AUTH_REFRESH_RETRY_MS);
          const activeRuntimeAuthState = params.getRuntimeAuthState();
          if (activeRuntimeAuthState) {
            activeRuntimeAuthState.refreshTimer = retryTimer;
          }
          if (params.getRuntimeAuthRefreshCancelled() && activeRuntimeAuthState) {
            clearTimeout(retryTimer);
            activeRuntimeAuthState.refreshTimer = undefined;
          }
        });
    }, delayMs);
    runtimeAuthState.refreshTimer = timer;
    if (params.getRuntimeAuthRefreshCancelled()) {
      clearTimeout(timer);
      runtimeAuthState.refreshTimer = undefined;
    }
  };

  const resolveAuthProfileFailoverReason = (failoverParams: {
    allInCooldown: boolean;
    message: string;
    profileIds?: Array<string | undefined>;
  }): FailoverReason => {
    if (failoverParams.allInCooldown) {
      const profileIds = (failoverParams.profileIds ?? params.profileCandidates).filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      return (
        resolveProfilesUnavailableReason({
          store: params.authStore,
          profileIds,
        }) ?? "unknown"
      );
    }
    const classified = classifyFailoverReason(failoverParams.message, {
      provider: params.getProvider(),
    });
    return classified ?? "auth";
  };

  const throwAuthProfileFailover = (failoverParams: {
    allInCooldown: boolean;
    message?: string;
    error?: unknown;
  }): never => {
    const provider = params.getProvider();
    const modelId = params.getModelId();
    const messageForReason =
      failoverParams.message?.trim() ||
      (failoverParams.error ? formatErrorMessage(failoverParams.error).trim() : "");
    const reason = resolveAuthProfileFailoverReason({
      allInCooldown: failoverParams.allInCooldown,
      message: messageForReason,
      profileIds: params.profileCandidates,
    });
    const message =
      failoverParams.message?.trim() ||
      formatAuthProfileFailureMessage({
        reason,
        provider,
        allInCooldown: failoverParams.allInCooldown,
        cause: failoverParams.error,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: process.env,
      });
    if (params.fallbackConfigured) {
      const authMode =
        reason === "billing"
          ? resolveSubscriptionAuthModeForProfiles({
              store: params.authStore,
              profileIds: failoverParams.allInCooldown
                ? params.profileCandidates
                : [params.profileCandidates[params.getProfileIndex()]],
            })
          : undefined;
      throw new FailoverError(message, {
        reason,
        provider,
        model: modelId,
        authMode,
        status: resolveFailoverStatus(reason),
        authProfileFailure: { allInCooldown: failoverParams.allInCooldown },
        cause: failoverParams.error,
      });
    }
    if (failoverParams.error instanceof Error) {
      throw failoverParams.error;
    }
    throw new Error(message);
  };

  const resolveApiKeyForCandidate = async (
    candidate?: string,
    model = params.getRuntimeModel(),
    allowAuthProfileFallback?: boolean,
  ) => {
    return getApiKeyForModel({
      model,
      cfg: params.config,
      profileId: candidate,
      store: params.authStore,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      lockedProfile: candidate != null && candidate === params.lockedProfileId,
      allowAuthProfileFallback,
      secretSentinels: true,
    });
  };

  const applyApiKeyInfo = async (candidate?: string, attemptIndex?: number): Promise<void> => {
    const preparedModel = await params.prepareModelForAuthProfile?.(candidate, attemptIndex);
    const apiKeyInfo = await resolveApiKeyForCandidate(
      candidate,
      preparedModel?.runtimeModel,
      preparedModel?.allowAuthProfileFallback,
    );
    if (
      preparedModel?.authRequirement &&
      !providerModelRouteAcceptsAuthMode({
        requirement: preparedModel.authRequirement,
        mode: apiKeyInfo.mode ?? (apiKeyInfo.apiKey ? "api-key" : undefined),
      })
    ) {
      throw new Error(
        `Resolved ${apiKeyInfo.mode ?? "unknown"} credentials are incompatible with the selected ${preparedModel.authRequirement} route for ${preparedModel.runtimeModel.provider}.`,
      );
    }
    // Preserve the checked source even when resolution fails before route commit.
    params.setApiKeyInfo(apiKeyInfo);
    const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        const runtimeModel = preparedModel?.runtimeModel ?? params.getRuntimeModel();
        throw new MissingProviderAuthError(runtimeModel.provider, apiKeyInfo);
      }
      commitPreparedModel(preparedModel);
      // AWS SDK auth via IMDS / instance role / ECS task role: no explicit API
      // key is available but the SDK default credential chain can resolve
      // credentials at runtime.  We must still call setRuntimeApiKey so that
      // OpenClaw runtime's authStorage considers the provider authenticated.  Try
      // prepareProviderRuntimeAuth first (it can sign requests and return a
      // short-lived token); fall back to a sentinel value when the provider
      // plugin does not implement runtime auth preparation.
      const runtimeModel = params.getRuntimeModel();
      const AWS_SDK_AUTH_SENTINEL = "__aws_sdk_auth__";
      try {
        const preparedAuth = await prepareRuntimeAuthForModel({
          runtimeModel,
          apiKey: AWS_SDK_AUTH_SENTINEL,
          authMode: apiKeyInfo.mode,
          profileId: apiKeyInfo.profileId,
        });
        applyPreparedRuntimeRequestOverrides({ runtimeModel, preparedAuth: preparedAuth ?? {} });
        if (preparedAuth?.apiKey) {
          clearRuntimeAuthRefreshTimer();
          params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
          params.setRuntimeAuthState({
            generation: nextRuntimeAuthGeneration(),
            sourceApiKey: AWS_SDK_AUTH_SENTINEL,
            authMode: apiKeyInfo.mode,
            profileId: resolvedProfileId,
            expiresAt: preparedAuth.expiresAt,
          });
          if (preparedAuth.expiresAt) {
            scheduleRuntimeAuthRefresh();
          }
          params.setLastProfileId(resolvedProfileId);
          return;
        }
      } catch (error) {
        params.log.warn(
          `prepareProviderRuntimeAuth failed for ${runtimeModel.provider}, falling back to sentinel: ${formatErrorMessage(error)}`,
        );
      }
      // No runtime auth plugin resolved a real credential.  Inject the
      // sentinel so OpenClaw runtime's hasConfiguredAuth() passes and the AWS SDK default
      // credential chain handles actual request signing.
      clearRuntimeAuthRefreshTimer();
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, AWS_SDK_AUTH_SENTINEL);
      params.setRuntimeAuthState(null);
      params.setLastProfileId(resolvedProfileId);
      return;
    }
    commitPreparedModel(preparedModel);
    let runtimeAuthHandled = false;
    const runtimeModel = params.getRuntimeModel();
    const preparedAuth = await prepareRuntimeAuthForModel({
      runtimeModel,
      apiKey: apiKeyInfo.apiKey,
      authMode: apiKeyInfo.mode,
      profileId: apiKeyInfo.profileId,
    });
    applyPreparedRuntimeRequestOverrides({ runtimeModel, preparedAuth: preparedAuth ?? {} });
    if (preparedAuth?.apiKey) {
      clearRuntimeAuthRefreshTimer();
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
      params.setRuntimeAuthState({
        generation: nextRuntimeAuthGeneration(),
        sourceApiKey: apiKeyInfo.apiKey,
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
        expiresAt: preparedAuth.expiresAt,
      });
      if (preparedAuth.expiresAt) {
        scheduleRuntimeAuthRefresh();
      }
      runtimeAuthHandled = true;
    }
    if (!runtimeAuthHandled) {
      clearRuntimeAuthRefreshTimer();
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, apiKeyInfo.apiKey);
      params.setRuntimeAuthState(null);
    }
    params.setLastProfileId(apiKeyInfo.profileId);
  };

  const advanceAuthProfile = async (): Promise<boolean> => {
    if (params.lockedProfileId) {
      return false;
    }
    let nextIndex = params.getProfileIndex() + 1;
    while (nextIndex < params.profileCandidates.length) {
      const candidate = params.profileCandidates[nextIndex];
      if (
        candidate &&
        isProfileInCooldown(params.authStore, candidate, undefined, params.getModelId())
      ) {
        nextIndex += 1;
        continue;
      }
      try {
        await applyApiKeyInfo(candidate, nextIndex);
        params.setProfileIndex(nextIndex);
        params.setThinkLevel(params.initialThinkLevel);
        params.attemptedThinking.clear();
        return true;
      } catch (err) {
        if (candidate && candidate === params.lockedProfileId) {
          throw err;
        }
        nextIndex += 1;
      }
    }
    return false;
  };

  const initializeAuthProfile = async () => {
    try {
      const modelId = params.getModelId();
      const cooldownProbePolicy = resolveEmbeddedAuthCooldownProbePolicy({
        authStore: params.authStore,
        profileCandidates: params.profileCandidates,
        lockedProfileId: params.lockedProfileId,
        modelId,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe,
      });
      let didTransientCooldownProbe = false;

      while (params.getProfileIndex() < params.profileCandidates.length) {
        const candidate = params.profileCandidates[params.getProfileIndex()];
        const inCooldown =
          candidate &&
          candidate !== params.lockedProfileId &&
          isProfileInCooldown(params.authStore, candidate, undefined, modelId);
        if (inCooldown) {
          if (cooldownProbePolicy.allowProbe && !didTransientCooldownProbe) {
            didTransientCooldownProbe = true;
            params.log.warn(
              `probing cooldowned auth profile for ${params.getProvider()}/${modelId} due to ${cooldownProbePolicy.unavailableReason ?? "transient"} unavailability`,
            );
          } else {
            params.setProfileIndex(params.getProfileIndex() + 1);
            continue;
          }
        }
        await applyApiKeyInfo(
          params.profileCandidates[params.getProfileIndex()],
          params.getProfileIndex(),
        );
        break;
      }
      if (params.getProfileIndex() >= params.profileCandidates.length) {
        throwAuthProfileFailover({ allInCooldown: true });
      }
    } catch (err) {
      if (err instanceof FailoverError) {
        throw err;
      }
      if (params.profileCandidates[params.getProfileIndex()] === params.lockedProfileId) {
        throwAuthProfileFailover({ allInCooldown: false, error: err });
      }
      const advanced = await advanceAuthProfile();
      if (!advanced) {
        throwAuthProfileFailover({ allInCooldown: false, error: err });
      }
    }
  };

  const maybeRefreshRuntimeAuthForAuthError = async (
    errorText: string,
    retried: boolean,
  ): Promise<boolean> => {
    if (!params.getRuntimeAuthState() || retried) {
      return false;
    }
    if (!isFailoverErrorMessage(errorText, { provider: params.getProvider() })) {
      return false;
    }
    if (classifyFailoverReason(errorText, { provider: params.getProvider() }) !== "auth") {
      return false;
    }
    try {
      await refreshRuntimeAuth("auth-error");
      scheduleRuntimeAuthRefresh();
      return true;
    } catch {
      return false;
    }
  };

  return {
    applyAuthProfileCandidate: applyApiKeyInfo,
    advanceAuthProfile,
    initializeAuthProfile,
    maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer,
  };
}
