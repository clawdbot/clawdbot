import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { type AuthProfileFailureReason, markAuthProfileFailure } from "../../auth-profiles.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { log } from "../logger.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import {
  MAX_SAME_MODEL_RATE_LIMIT_RETRIES,
  resolveNextSameModelRateLimitRetryCount,
  resolveOverloadFailoverBackoffMs,
  resolveOverloadProfileRotationLimit,
  resolveRateLimitProfileRotationLimit,
  resolveSameModelRateLimitRetryDelayMs,
} from "./helpers.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;

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
  const overloadFailoverBackoffMs = resolveOverloadFailoverBackoffMs();
  const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit();
  const rateLimitProfileRotationLimit = resolveRateLimitProfileRotationLimit();
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

  return {
    overloadProfileRotationLimit,
    rateLimitProfileRotationLimit,
    get rateLimitProfileRotations() {
      return rateLimitProfileRotations;
    },
    get consecutiveSameModelRateLimitRetries() {
      return consecutiveSameModelRateLimitRetries;
    },
    resetSameModelRateLimitRetries: () => {
      consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
        retriesSoFar: consecutiveSameModelRateLimitRetries,
        retriedSameModelRateLimit: false,
      });
    },
    maybeEscalateRateLimitProfileFallback: (paramsLocal: {
      failoverProvider: string;
      failoverModel: string;
      logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
    }) => {
      rateLimitProfileRotations += 1;
      if (rateLimitProfileRotations <= rateLimitProfileRotationLimit || !fallbackConfigured) {
        return;
      }
      const status = resolveFailoverStatus("rate_limit");
      log.warn(
        `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
      );
      paramsLocal.logFallbackDecision("fallback_model", { status });
      throw new FailoverError(
        "The AI service is temporarily rate-limited. Please try again in a moment.",
        {
          reason: "rate_limit",
          provider: paramsLocal.failoverProvider,
          model: paramsLocal.failoverModel,
          profileId: input.getLastProfileId(),
          sessionId: input.getSessionId(),
          lane: globalLane,
          status,
        },
      );
    },
    maybeMarkAuthProfileFailure: async (failure: {
      profileId?: string;
      reason?: AuthProfileFailureReason | null;
      modelId?: string;
    }) => {
      if (params.authProfileStateMode === "read-only") {
        return;
      }
      const { profileId, reason } = failure;
      if (!profileId || !reason) {
        return;
      }
      if (input.harnessOwnsTransport() && reason === "timeout") {
        return;
      }
      await markAuthProfileFailure({
        store: profileFailureStore,
        profileId,
        reason,
        cfg: params.config,
        agentDir,
        runId: params.runId,
        modelId: failure.modelId,
      });
    },
    resolveAuthProfileFailureReason: (
      failoverReason: FailoverReason | null,
      opts?: { providerStarted?: boolean; transientRateLimit?: boolean },
    ) => {
      return resolveAuthProfileFailureReason({
        failoverReason,
        providerStarted: opts?.providerStarted,
        transientRateLimit: opts?.transientRateLimit,
        policy: params.authProfileFailurePolicy,
      });
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
      if (consecutiveSameModelRateLimitRetries >= MAX_SAME_MODEL_RATE_LIMIT_RETRIES) {
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
