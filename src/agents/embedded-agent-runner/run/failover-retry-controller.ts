import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import {
  type AuthProfileFailureReason,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
} from "../../auth-profiles.js";
import { revokeRuntimeAuthMaterializations } from "../../auth-profiles/runtime-materializations.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { resolveFailoverReasonFromError } from "../../failover-error.js";
import { isConfigBackedInlineProviderApiKey, type ResolvedProviderAuth } from "../../model-auth.js";
import { log } from "../logger.js";
import type { TraceAttempt } from "../types.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import {
  MAX_SAME_MODEL_RATE_LIMIT_RETRIES,
  resolveNextSameModelRateLimitRetryCount,
  resolveOverloadFailoverBackoffMs,
  resolveOverloadProfileRotationLimit,
  resolveSameModelRateLimitRetryDelayMs,
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
    agentDir,
    fallbackConfigured,
    profileFailureStore,
  } = input;
  const overloadFailoverBackoffMs = resolveOverloadFailoverBackoffMs();
  const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit();
  let rateLimitProfileRotations = 0;
  let consecutiveSameModelRateLimitRetries = 0;

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
    get consecutiveSameModelRateLimitRetries() {
      return consecutiveSameModelRateLimitRetries;
    },
    resetSameModelRateLimitRetries: () => {
      consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
        retriesSoFar: consecutiveSameModelRateLimitRetries,
        retriedSameModelRateLimit: false,
      });
    },
    advanceAuthProfile: input.advanceAuthProfile,
    advanceRateLimitAuthProfile: async (
      _context: RateLimitAuthProfileContext,
    ): Promise<boolean> => {
      const rotated = await input.advanceAuthProfile();
      if (rotated) {
        rateLimitProfileRotations += 1;
        return true;
      }
      if (fallbackConfigured) {
        log.warn(
          `rate-limit auth profiles exhausted for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
        );
      }
      return false;
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
    maybeBackoffBeforeOverloadFailover: async (reason: FailoverReason | null) => {
      if (reason !== "overloaded" || overloadFailoverBackoffMs <= 0) {
        return;
      }
      log.warn(
        `overload backoff before failover for ${provider}/${modelId}: delayMs=${overloadFailoverBackoffMs}`,
      );
      await sleepForRetry(overloadFailoverBackoffMs);
    },
    maybeRetrySameModelRateLimit: async (retry?: {
      retryAfterSeconds?: number;
    }): Promise<boolean> => {
      if (
        rateLimitProfileRotations > 0 ||
        consecutiveSameModelRateLimitRetries >= MAX_SAME_MODEL_RATE_LIMIT_RETRIES
      ) {
        return false;
      }
      const delayMs = resolveSameModelRateLimitRetryDelayMs({
        retriesSoFar: consecutiveSameModelRateLimitRetries,
        retryAfterSeconds: retry?.retryAfterSeconds,
      });
      log.warn(
        `rate-limit same-model retry ${consecutiveSameModelRateLimitRetries + 1}/${MAX_SAME_MODEL_RATE_LIMIT_RETRIES} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)}: delayMs=${delayMs}`,
      );
      await sleepForRetry(delayMs);
      consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
        retriesSoFar: consecutiveSameModelRateLimitRetries,
        retriedSameModelRateLimit: true,
      });
      return true;
    },
  };
}
