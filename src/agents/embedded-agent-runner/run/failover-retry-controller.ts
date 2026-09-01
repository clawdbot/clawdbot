import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import {
  type AuthProfileFailureReason,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
} from "../../auth-profiles.js";
import { revokeRuntimeAuthMaterializations } from "../../auth-profiles/runtime-materializations.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import {
  FailoverError,
  resolveFailoverReasonFromError,
  resolveFailoverStatus,
} from "../../failover-error.js";
import { isConfigBackedInlineProviderApiKey, type ResolvedProviderAuth } from "../../model-auth.js";
import { log } from "../logger.js";
import type { TraceAttempt } from "../types.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import {
  MAX_TRANSIENT_RETRIES,
  resolveTransientRetryDelayMs,
  resolveOverloadProfileRotationLimit,
  resolveRateLimitProfileRotationLimit,
} from "./helpers.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
type AuthRetryTrace = TraceAttempt & { reason: FailoverReason };

type RateLimitAuthProfileContext = {
  failoverProvider: string;
  failoverModel: string;
  logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
};

export function createEmbeddedRunFailoverRetryController(input: {
  runParams: PreparedEmbeddedRunInput["runParams"];
  provider: string;
  modelId: string;
  globalLane: string;
  agentDir: string;
  fallbackConfigured: boolean;
  profileFailureStore: PreparedRuntime["profileFailureStore"];
  getLastProfileId: () => string | undefined;
  getSessionId: () => string;
  harnessOwnsTransport: () => boolean;
  getRuntimeAuthOwnerId: () => string;
  getApiKeyInfo: () => ResolvedProviderAuth | null;
  advanceAuthProfile: PreparedRuntime["advanceAttemptAuthProfile"];
}) {
  const {
    runParams: params,
    provider,
    modelId,
    globalLane,
    agentDir,
    fallbackConfigured,
    profileFailureStore,
  } = input;
  const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit();
  const rateLimitProfileRotationLimit = resolveRateLimitProfileRotationLimit();
  let rateLimitProfileRotations = 0;
  let transientRetryCount = 0;
  let transientRetryBudget = MAX_TRANSIENT_RETRIES;
  // Wall-clock anchor set at the first transient consult so the 90s budget
  // counts failed-request time, not only backoff sleeps; a slow provider
  // timeout consumes budget instead of extending the retry window.
  let transientRetryWindowStartMs: number | null = null;

  const sleepForRetry = async (delayMs: number) => {
    try {
      await sleepWithAbort(delayMs, params.abortSignal);
    } catch (error) {
      if (!params.abortSignal?.aborted) {
        throw error;
      }
      const abortError = new Error("Operation aborted", { cause: error });
      abortError.name = "AbortError";
      throw abortError;
    }
  };

  const resolveProfileFailureReason = (
    failoverReason: FailoverReason | null,
    opts?: { providerStarted?: boolean; transientRateLimit?: boolean },
  ) =>
    resolveAuthProfileFailureReason({
      failoverReason,
      providerStarted: opts?.providerStarted,
      transientRateLimit: opts?.transientRateLimit,
      policy: params.authProfileFailurePolicy,
    });

  const maybeMarkAuthProfileFailure = async (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => {
    const { profileId, reason } = failure;
    if (input.harnessOwnsTransport() && (reason === "auth" || reason === "auth_permanent")) {
      revokeRuntimeAuthMaterializations({
        agentDir,
        provider,
        runtimeOwnerId: input.getRuntimeAuthOwnerId(),
      });
    }
    if (params.authProfileStateMode === "read-only" || !reason) {
      return;
    }
    if (input.harnessOwnsTransport() && reason === "timeout") {
      return;
    }
    if (profileId) {
      await markAuthProfileFailure({
        store: profileFailureStore,
        profileId,
        reason,
        cfg: params.config,
        agentDir,
        runId: params.runId,
        modelId: failure.modelId,
      });
      return;
    }
    const apiKeyInfo = input.getApiKeyInfo();
    if (
      apiKeyInfo?.mode !== "api-key" ||
      !isConfigBackedInlineProviderApiKey({
        cfg: params.config,
        provider,
        source: apiKeyInfo.source,
        store: profileFailureStore,
      })
    ) {
      return;
    }
    await markInlineProviderApiKeyFailure({
      store: profileFailureStore,
      provider,
      reason,
      cfg: params.config,
      agentDir,
      runId: params.runId,
      modelId: failure.modelId,
    });
  };

  return {
    overloadProfileRotationLimit,
    get transientRetryCount() {
      return transientRetryCount;
    },
    // Saved retry.provider.maxRetries keeps its meaning as the transient-retry
    // attempt budget, now owned here instead of per-SDK-request.
    setTransientRetryBudget: (maxRetries?: number) => {
      transientRetryBudget = maxRetries ?? MAX_TRANSIENT_RETRIES;
    },
    advanceAuthProfile: input.advanceAuthProfile,
    advanceRateLimitAuthProfile: async (context: RateLimitAuthProfileContext): Promise<boolean> => {
      if (rateLimitProfileRotations >= rateLimitProfileRotationLimit && fallbackConfigured) {
        const status = resolveFailoverStatus("rate_limit");
        log.warn(
          `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
        );
        context.logFallbackDecision("fallback_model", { status });
        throw new FailoverError(
          "The AI service is temporarily rate-limited. Please try again in a moment.",
          {
            reason: "rate_limit",
            provider: context.failoverProvider,
            model: context.failoverModel,
            profileId: input.getLastProfileId(),
            sessionId: input.getSessionId(),
            lane: globalLane,
            status,
          },
        );
      }
      const rotated = await input.advanceAuthProfile();
      if (rotated) {
        rateLimitProfileRotations += 1;
      }
      return rotated;
    },
    maybeMarkAuthProfileFailure,
    resolveAuthProfileFailureReason: resolveProfileFailureReason,
    recoverThrownHarnessAuthFailure: async (error: unknown): Promise<AuthRetryTrace | null> => {
      // Native harnesses can throw before returning a terminal result. Recover only
      // provider-auth failures here; local harness faults must keep propagating.
      if (!input.harnessOwnsTransport()) {
        return null;
      }
      const failoverReason = resolveFailoverReasonFromError(error, provider);
      if (failoverReason !== "auth" && failoverReason !== "auth_permanent") {
        return null;
      }
      const failedProfileId = input.getLastProfileId();
      const profileFailureReason = resolveProfileFailureReason(failoverReason);
      const userPinnedProfile =
        params.authProfileIdSource === "user" && failedProfileId === params.authProfileId;
      const rotated = userPinnedProfile ? false : await input.advanceAuthProfile();
      try {
        await maybeMarkAuthProfileFailure({
          profileId: failedProfileId,
          reason: profileFailureReason,
          modelId,
        });
      } catch (markError) {
        log.warn(`profile failure mark failed: ${String(markError)}`);
      }
      return rotated
        ? {
            provider,
            model: modelId,
            result: "rotate_profile",
            reason: failoverReason,
            stage: "prompt",
          }
        : null;
    },
    maybeRetryTransient: async (retry: {
      reason: FailoverReason;
      retryAfterMs?: number;
    }): Promise<boolean> => {
      if (
        retry.reason !== "rate_limit" &&
        retry.reason !== "overloaded" &&
        retry.reason !== "server_error" &&
        retry.reason !== "timeout"
      ) {
        return false;
      }
      if (transientRetryCount >= transientRetryBudget) {
        return false;
      }
      const nowMs = Date.now();
      transientRetryWindowStartMs ??= nowMs;
      const delayMs = resolveTransientRetryDelayMs({
        retryNumber: transientRetryCount + 1,
        retryAfterMs: retry.retryAfterMs,
        elapsedMs: nowMs - transientRetryWindowStartMs,
      });
      if (delayMs === undefined) {
        // The window in resolveTransientRetryDelayMs outranks the attempt budget when
        // requests are slow, so record the truncation: a configured maxRetries that
        // never runs must be diagnosable. Failover is the better recovery past here.
        log.warn(
          `transient retry window elapsed for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${transientRetryCount}/${transientRetryBudget} retries; failing over`,
        );
        return false;
      }
      log.warn(
        `transient same-model retry ${transientRetryCount + 1}/${transientRetryBudget} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} reason=${retry.reason}: delayMs=${delayMs}`,
      );
      await sleepForRetry(delayMs);
      transientRetryCount += 1;
      return true;
    },
  };
}
