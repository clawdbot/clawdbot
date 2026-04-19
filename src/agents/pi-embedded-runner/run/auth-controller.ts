import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { prepareProviderRuntimeAuth } from "../../../plugins/provider-runtime.js";
import {
  type AuthProfileStore,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
} from "../../auth-profiles.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { shouldAllowCooldownProbeForReason } from "../../failover-policy.js";
import { getApiKeyForModel, type ResolvedProviderAuth } from "../../model-auth.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  type FailoverReason,
} from "../../pi-embedded-helpers.js";
import {
  resolveProviderRequestConfig,
  sanitizeRuntimeProviderRequestOverrides,
} from "../../provider-request-config.js";
import { clampRuntimeAuthRefreshDelayMs } from "../../runtime-auth-refresh.js";
import {
  RUNTIME_AUTH_REFRESH_MARGIN_MS,
  RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
  RUNTIME_AUTH_REFRESH_RETRY_MS,
  type RuntimeAuthState,
} from "./helpers.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";

type ApiKeyInfo = ResolvedProviderAuth;

type RuntimeApiKeySink = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
};

type LogLike = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

export function createEmbeddedRunAuthController(params: {
  config: RunEmbeddedPiAgentParams["config"];
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
  getRuntimeModel(): Model<Api>;
  setRuntimeModel(next: Model<Api>): void;
  getEffectiveModel(): Model<Api>;
  setEffectiveModel(next: Model<Api>): void;
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
  setThinkLevel(next: ThinkLevel): void;
  log: LogLike;
}) {
  const applyPreparedRuntimeRequestOverrides = (paramsForApply: {
    runtimeModel: Model<Api>;
    preparedAuth: {
      baseUrl?: string;
      request?: Parameters<typeof resolveProviderRequestConfig>[0]["request"];
    };
  }): void => {
    if (!paramsForApply.preparedAuth.baseUrl && !paramsForApply.preparedAuth.request) {
      return;
    }
    const runtimeRequestConfig = resolveProviderRequestConfig({
      provider: paramsForApply.runtimeModel.provider,
      api: paramsForApply.runtimeModel.api,
      baseUrl: paramsForApply.preparedAuth.baseUrl ?? paramsForApply.runtimeModel.baseUrl,
      providerHeaders:
        paramsForApply.runtimeModel.headers &&
        typeof paramsForApply.runtimeModel.headers === "object"
          ? paramsForApply.runtimeModel.headers
          : undefined,
      request: sanitizeRuntimeProviderRequestOverrides(paramsForApply.preparedAuth.request),
      capability: "llm",
      transport: "stream",
    });
    params.setRuntimeModel({
      ...paramsForApply.runtimeModel,
      ...(paramsForApply.preparedAuth.baseUrl
        ? { baseUrl: paramsForApply.preparedAuth.baseUrl }
        : {}),
      ...(runtimeRequestConfig.headers ? { headers: runtimeRequestConfig.headers } : {}),
    });
    params.setEffectiveModel({
      ...params.getEffectiveModel(),
      ...(paramsForApply.preparedAuth.baseUrl
        ? { baseUrl: paramsForApply.preparedAuth.baseUrl }
        : {}),
      ...(runtimeRequestConfig.headers ? { headers: runtimeRequestConfig.headers } : {}),
    });
  };

  const hasRefreshableRuntimeAuth = () =>
    Boolean(params.getRuntimeAuthState()?.sourceApiKey.trim());

  const nextRuntimeAuthGeneration = () => (params.getRuntimeAuthState()?.generation ?? 0) + 1;

  const prepareRuntimeAuthForModel = async (prepareParams: {
    runtimeModel: Model<Api>;
    apiKey: string;
    authMode: string;
    profileId?: string;
  }) =>
    prepareProviderRuntimeAuth({
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
        apiKey: prepareParams.apiKey,
        authMode: prepareParams.authMode,
        profileId: prepareParams.profileId,
      },
    });

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
    const refreshGeneration = runtimeAuthState.generation;
    const refreshProfileId = runtimeAuthState.profileId;
    let refreshPromise: Promise<void>;
    refreshPromise = (async () => {
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
      .catch((err) => {
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
    const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
    const message =
      failoverParams.message?.trim() ||
      (failoverParams.error ? formatErrorMessage(failoverParams.error).trim() : "") ||
      fallbackMessage;
    const reason = resolveAuthProfileFailoverReason({
      allInCooldown: failoverParams.allInCooldown,
      message,
      profileIds: params.profileCandidates,
    });
    if (params.fallbackConfigured) {
      throw new FailoverError(message, {
        reason,
        provider,
        model: modelId,
        status: resolveFailoverStatus(reason),
        cause: failoverParams.error,
      });
    }
    if (failoverParams.error instanceof Error) {
      throw failoverParams.error;
    }
    throw new Error(message);
  };

  const resolveApiKeyForCandidate = async (candidate?: string) => {
    return getApiKeyForModel({
      model: params.getRuntimeModel(),
      cfg: params.config,
      profileId: candidate,
      store: params.authStore,
      agentDir: params.agentDir,
      lockedProfile: candidate != null && candidate === params.lockedProfileId,
    });
  };

  const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
    const apiKeyInfo = await resolveApiKeyForCandidate(candidate);
    params.setApiKeyInfo(apiKeyInfo);
    const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        const runtimeModel = params.getRuntimeModel();
        throw new Error(
          `No API key resolved for provider "${runtimeModel.provider}" (auth mode: ${apiKeyInfo.mode}).`,
        );
      }
      params.setLastProfileId(resolvedProfileId);
      return;
    }
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
        await applyApiKeyInfo(candidate);
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
      const autoProfileCandidates = params.profileCandidates.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" &&
          candidate.length > 0 &&
          candidate !== params.lockedProfileId,
      );
      const modelId = params.getModelId();
      const allAutoProfilesInCooldown =
        autoProfileCandidates.length > 0 &&
        autoProfileCandidates.every((candidate) =>
          isProfileInCooldown(params.authStore, candidate, undefined, modelId),
        );
      const unavailableReason = allAutoProfilesInCooldown
        ? (resolveProfilesUnavailableReason({
            store: params.authStore,
            profileIds: autoProfileCandidates,
          }) ?? "unknown")
        : null;
      const allowTransientCooldownProbe =
        params.allowTransientCooldownProbe &&
        allAutoProfilesInCooldown &&
        shouldAllowCooldownProbeForReason(unavailableReason);
      let didTransientCooldownProbe = false;

      while (params.getProfileIndex() < params.profileCandidates.length) {
        const candidate = params.profileCandidates[params.getProfileIndex()];
        const inCooldown =
          candidate &&
          candidate !== params.lockedProfileId &&
          isProfileInCooldown(params.authStore, candidate, undefined, modelId);
        if (inCooldown) {
          if (allowTransientCooldownProbe && !didTransientCooldownProbe) {
            didTransientCooldownProbe = true;
            params.log.warn(
              `probing cooldowned auth profile for ${params.getProvider()}/${modelId} due to ${unavailableReason ?? "transient"} unavailability`,
            );
          } else {
            params.setProfileIndex(params.getProfileIndex() + 1);
            continue;
          }
        }
        await applyApiKeyInfo(params.profileCandidates[params.getProfileIndex()]);
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
    advanceAuthProfile,
    initializeAuthProfile,
    maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer,
  };
}
