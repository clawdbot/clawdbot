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
import { MAX_TRANSIENT_RETRIES, resolveTransientRetryDelayMs } from "./helpers.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

const MAX_RATE_LIMIT_ATTEMPTS = 10;
const MAX_OVERLOAD_PROFILE_ROTATIONS = 1;
const MAX_RATE_LIMIT_PROFILE_ROTATIONS = 1;
const RETRY_SLEEP_CHUNK_MS = 24 * 60 * 60 * 1000;

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
export type EmbeddedRunFailoverRetryController = ReturnType<
  typeof createEmbeddedRunFailoverRetryController
>;
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
  let rateLimitProfileRotations = 0;
  let transientRetryCount = 0;
  let rateLimitSeen = false;
  let transientRetryBudget: number | undefined;
  // Wall-clock anchor set at the first transient consult so the 90s budget
  // counts failed-request time, not only backoff sleeps; a slow provider
  // timeout consumes budget instead of extending the retry window.
  let transientRetryWindowStartMs: number | null = null;

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
    overloadProfileRotationLimit: MAX_OVERLOAD_PROFILE_ROTATIONS,
    get transientRetryCount() {
      return transientRetryCount;
    },
    // Saved retry.provider.maxRetries keeps its meaning as the transient-retry
    // attempt budget, now owned here instead of per-SDK-request.
    setTransientRetryBudget: (maxRetries?: number) => {
      transientRetryBudget = maxRetries;
    },
    advanceAuthProfile: input.advanceAuthProfile,
    advanceRateLimitAuthProfile: async (context: RateLimitAuthProfileContext): Promise<boolean> => {
      if (rateLimitProfileRotations >= MAX_RATE_LIMIT_PROFILE_ROTATIONS && fallbackConfigured) {
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
      onRetry?: (status: {
        attempt: number;
        maxRetries: number;
        delayMs: number;
        reason: FailoverReason;
      }) => void | Promise<void>;
    }): Promise<boolean> => {
      if (
        retry.reason !== "rate_limit" &&
        retry.reason !== "overloaded" &&
        retry.reason !== "server_error" &&
        retry.reason !== "timeout"
      ) {
        return false;
      }
      const rateLimit = retry.reason === "rate_limit";
      rateLimitSeen ||= rateLimit;
      const retryCount = transientRetryCount;
      const retryBudget = Math.min(
        transientRetryBudget ?? (rateLimit ? MAX_RATE_LIMIT_ATTEMPTS - 1 : MAX_TRANSIENT_RETRIES),
        rateLimitSeen ? MAX_RATE_LIMIT_ATTEMPTS - 1 : Infinity,
      );
      if (retryCount >= retryBudget) {
        return false;
      }
      const nowMs = Date.now();
      transientRetryWindowStartMs ??= nowMs;
      const delayMs = resolveTransientRetryDelayMs({
        retryNumber: retryCount + 1,
        retryAfterMs: retry.retryAfterMs,
        elapsedMs: rateLimit ? undefined : nowMs - transientRetryWindowStartMs,
      });
      if (delayMs === undefined) {
        // The window in resolveTransientRetryDelayMs outranks the attempt budget when
        // requests are slow, so record the truncation: a configured maxRetries that
        // never runs must be diagnosable. Failover is the better recovery past here.
        log.warn(
          `transient retry ${retry.retryAfterMs === Infinity ? "floor exceeds representable time" : "window elapsed"} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${transientRetryCount}/${retryBudget} retries; failing over`,
        );
        return false;
      }
      log.warn(
        `transient same-model retry ${retryCount + 1}/${retryBudget} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} reason=${retry.reason}: delayMs=${delayMs}`,
      );
      await retry.onRetry?.({
        attempt: retryCount + 1,
        maxRetries: retryBudget,
        delayMs,
        reason: retry.reason,
      });
      // Provider floors can exceed one native timer; the shared helper owns abort errors.
      let remainingMs = delayMs;
      while (remainingMs > 0) {
        const chunkMs = Math.min(remainingMs, RETRY_SLEEP_CHUNK_MS);
        await sleepWithAbort(chunkMs, params.abortSignal);
        remainingMs -= chunkMs;
      }
      transientRetryCount += 1;
      return true;
    },
  };
}
