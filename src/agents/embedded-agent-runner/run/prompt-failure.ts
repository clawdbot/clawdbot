import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "../../auth-profiles.js";
import {
  classifyFailoverReason,
  type FailoverReason,
  isFailoverErrorMessage,
  parseImageSizeError,
  pickFallbackThinkingLevel,
} from "../../embedded-agent-helpers.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  resolveFailoverStatus,
} from "../../failover-error.js";
import {
  resolveSessionSuspensionReason,
  type SessionSuspensionParams,
} from "../../session-suspension.js";
import { log } from "../logger.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult, TraceAttempt } from "../types.js";
import { isShortWindowRateLimitMessage } from "./assistant-failover.js";
import { buildEmbeddedRunBlockedResult } from "./blocked-run-result.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type PromptFailureOutcome =
  | {
      action: "retry";
      thinkLevel: ThinkLevel;
      authRetryPending: boolean;
      lastRetryFailoverReason: FailoverReason | null;
    }
  | { action: "complete"; result: EmbeddedAgentRunResult };

export async function handleEmbeddedPromptFailure(input: {
  runParams: RunEmbeddedAgentParams;
  attempt: EmbeddedRunAttemptResult;
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  activeErrorContext: { provider: string; model: string };
  provider: string;
  modelId: string;
  authProfileId?: string;
  authProfileStore: AuthProfileStore;
  sessionIdUsed: string;
  lane: string;
  agentDir: string;
  suspensionSessionId: string;
  runtimeAuthRetry: boolean;
  maybeRefreshRuntimeAuthForAuthError: (errorText: string, retry: boolean) => Promise<boolean>;
  suspendForFailure: (params: Omit<SessionSuspensionParams, "laneId">) => void;
  resolveReplayInvalid: () => boolean;
  setTerminalLifecycleMeta: NonNullable<EmbeddedRunAttemptResult["setTerminalLifecycleMeta"]>;
  buildErrorAgentMeta: () => EmbeddedAgentMeta;
  startedAtMs: number;
  fallbackConfigured: boolean;
  aborted: boolean;
  externalAbort: boolean;
  pluginHarnessOwnsTransport: boolean;
  timedOutByRunBudget: boolean;
  resolveAuthProfileFailureReason: (
    reason: FailoverReason | null,
    options?: { providerStarted?: boolean; transientRateLimit?: boolean },
  ) => AuthProfileFailureReason | null;
  maybeEscalateRateLimitProfileFallback: (params: {
    failoverProvider: string;
    failoverModel: string;
    logFallbackDecision: ReturnType<typeof createFailoverDecisionLogger>;
  }) => void;
  advanceAttemptAuthProfile: () => Promise<boolean>;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeBackoffBeforeOverloadFailover: (reason: FailoverReason | null) => Promise<void>;
  attemptedThinking: Set<ThinkLevel>;
  thinkLevel: ThinkLevel;
  // Profile rotation resets thinking inside the runtime; read it after advancing.
  getThinkLevel: () => ThinkLevel;
  traceAttempts: TraceAttempt[];
  previousRetryFailoverReason: FailoverReason | null;
}): Promise<PromptFailureOutcome> {
  const promptAuthMode = input.authProfileId
    ? input.authProfileStore.profiles?.[input.authProfileId]?.type
    : undefined;
  const normalizedPromptFailover = coerceToFailoverError(input.promptError, {
    provider: input.activeErrorContext.provider,
    model: input.activeErrorContext.model,
    profileId: input.authProfileId,
    authMode: promptAuthMode,
    sessionId: input.sessionIdUsed,
    lane: input.lane,
  });
  const promptErrorDetails = normalizedPromptFailover
    ? describeFailoverError(normalizedPromptFailover)
    : describeFailoverError(input.promptError);
  if (normalizedPromptFailover?.suspend) {
    input.suspendForFailure({
      cfg: input.runParams.config,
      agentDir: input.agentDir,
      sessionId: input.suspensionSessionId,
      reason: resolveSessionSuspensionReason(normalizedPromptFailover.reason),
      failedProvider: normalizedPromptFailover.provider ?? input.provider,
      failedModel: normalizedPromptFailover.model ?? input.modelId,
    });
  }
  const errorText = promptErrorDetails.message || formatErrorMessage(input.promptError);
  if (await input.maybeRefreshRuntimeAuthForAuthError(errorText, input.runtimeAuthRetry)) {
    return {
      action: "retry",
      thinkLevel: input.thinkLevel,
      authRetryPending: true,
      lastRetryFailoverReason: input.previousRetryFailoverReason,
    };
  }

  const blockedResult = resolveBlockedPromptResult(input, errorText);
  if (blockedResult) {
    return { action: "complete", result: blockedResult };
  }

  const promptFailoverReason =
    promptErrorDetails.reason ?? classifyFailoverReason(errorText, { provider: input.provider });
  const promptProfileFailureReason = input.resolveAuthProfileFailureReason(promptFailoverReason, {
    providerStarted: input.promptErrorSource === "prompt",
    transientRateLimit:
      promptFailoverReason === "rate_limit" && isShortWindowRateLimitMessage(errorText),
  });
  const promptFailoverFailure =
    promptFailoverReason !== null ||
    isFailoverErrorMessage(errorText, { provider: input.provider });
  const promptTimeoutFallbackSafe =
    input.promptErrorSource === "prompt" &&
    promptFailoverReason === "timeout" &&
    !input.attempt.codexAppServerFailure &&
    input.attempt.promptTimeoutOutcome?.replayInvalid !== true &&
    input.attempt.replayMetadata.replaySafe;
  const failedProfileId = input.authProfileId;
  const logFailoverDecision = createFailoverDecisionLogger({
    stage: "prompt",
    runId: input.runParams.runId,
    rawError: errorText,
    failoverReason: promptFailoverReason,
    profileFailureReason: promptProfileFailureReason,
    provider: input.provider,
    model: input.modelId,
    sourceProvider: input.provider,
    sourceModel: input.modelId,
    profileId: failedProfileId,
    fallbackConfigured: input.fallbackConfigured,
    aborted: input.aborted,
  });
  if (promptFailoverReason === "rate_limit") {
    input.maybeEscalateRateLimitProfileFallback({
      failoverProvider: input.provider,
      failoverModel: input.modelId,
      logFallbackDecision: logFailoverDecision,
    });
  }
  let failoverDecision = resolveRunFailoverDecision({
    stage: "prompt",
    aborted: input.aborted,
    externalAbort: input.externalAbort,
    fallbackConfigured: input.fallbackConfigured,
    failoverCode: promptErrorDetails.code,
    failoverFailure: promptFailoverFailure,
    failoverReason: promptFailoverReason,
    harnessOwnsTransport: input.pluginHarnessOwnsTransport,
    promptTimeoutFallbackSafe,
    timedOutByRunBudget: input.timedOutByRunBudget,
    profileRotated: false,
  });
  if (failoverDecision.action === "rotate_profile" && (await input.advanceAttemptAuthProfile())) {
    if (promptProfileFailureReason) {
      void input
        .maybeMarkAuthProfileFailure({
          profileId: failedProfileId,
          reason: promptProfileFailureReason,
          modelId: input.modelId,
        })
        .catch((error: unknown) => {
          log.warn(`prompt profile failure mark failed: ${String(error)}`);
        });
    }
    input.traceAttempts.push({
      provider: input.provider,
      model: input.modelId,
      result: promptFailoverReason === "timeout" ? "timeout" : "rotate_profile",
      ...(promptFailoverReason ? { reason: promptFailoverReason } : {}),
      stage: "prompt",
    });
    const lastRetryFailoverReason = mergeRetryFailoverReason({
      previous: input.previousRetryFailoverReason,
      failoverReason: promptFailoverReason,
    });
    logFailoverDecision("rotate_profile");
    await input.maybeBackoffBeforeOverloadFailover(promptFailoverReason);
    return {
      action: "retry",
      thinkLevel: input.getThinkLevel(),
      authRetryPending: false,
      lastRetryFailoverReason,
    };
  }
  if (failoverDecision.action === "rotate_profile") {
    failoverDecision = resolveRunFailoverDecision({
      stage: "prompt",
      aborted: input.aborted,
      externalAbort: input.externalAbort,
      fallbackConfigured: input.fallbackConfigured,
      failoverCode: promptErrorDetails.code,
      failoverFailure: promptFailoverFailure,
      failoverReason: promptFailoverReason,
      harnessOwnsTransport: input.pluginHarnessOwnsTransport,
      promptTimeoutFallbackSafe,
      timedOutByRunBudget: input.timedOutByRunBudget,
      profileRotated: true,
    });
  }
  if (promptProfileFailureReason) {
    try {
      await input.maybeMarkAuthProfileFailure({
        profileId: failedProfileId,
        reason: promptProfileFailureReason,
        modelId: input.modelId,
      });
    } catch (error) {
      log.warn(`prompt profile failure mark failed: ${String(error)}`);
    }
  }
  const fallbackThinking = pickFallbackThinkingLevel({
    message: errorText,
    attempted: input.attemptedThinking,
  });
  if (fallbackThinking) {
    log.warn(
      `unsupported thinking level for ${input.provider}/${input.modelId}; retrying with ${fallbackThinking}`,
    );
    return {
      action: "retry",
      thinkLevel: fallbackThinking,
      authRetryPending: false,
      lastRetryFailoverReason: input.previousRetryFailoverReason,
    };
  }
  if (failoverDecision.action === "fallback_model") {
    const fallbackReason = failoverDecision.reason ?? "unknown";
    const status = resolveFailoverStatus(fallbackReason);
    input.traceAttempts.push({
      provider: input.provider,
      model: input.modelId,
      result: promptFailoverReason === "timeout" ? "timeout" : "fallback_model",
      reason: fallbackReason,
      stage: "prompt",
      ...(typeof status === "number" ? { status } : {}),
    });
    logFailoverDecision("fallback_model", { status });
    await input.maybeBackoffBeforeOverloadFailover(promptFailoverReason);
    throw (
      normalizedPromptFailover ??
      new FailoverError(errorText, {
        reason: fallbackReason,
        provider: input.provider,
        model: input.modelId,
        profileId: input.authProfileId,
        authMode: promptAuthMode,
        sessionId: input.sessionIdUsed,
        lane: input.lane,
        status,
      })
    );
  }
  if (failoverDecision.action === "surface_error") {
    input.traceAttempts.push({
      provider: input.provider,
      model: input.modelId,
      result: promptFailoverReason === "timeout" ? "timeout" : "surface_error",
      ...(promptFailoverReason ? { reason: promptFailoverReason } : {}),
      stage: "prompt",
    });
    logFailoverDecision("surface_error");
  }
  throw toErrorObject(input.promptError, "Prompt failed");
}

function resolveBlockedPromptResult(
  input: Parameters<typeof handleEmbeddedPromptFailure>[0],
  errorText: string,
): EmbeddedAgentRunResult | undefined {
  let text: string;
  let errorKind: "role_ordering" | "image_size";
  if (/incorrect role information|roles must alternate/i.test(errorText)) {
    text =
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session.";
    errorKind = "role_ordering";
  } else {
    const imageSizeError = parseImageSizeError(errorText);
    if (!imageSizeError) {
      return undefined;
    }
    const maxMb = imageSizeError.maxMb;
    const maxMbLabel = typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
    const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
    text =
      `Image too large for the model${maxBytesHint}. ` +
      "Please compress or resize the image and try again.";
    errorKind = "image_size";
  }
  const replayInvalid = input.resolveReplayInvalid();
  input.setTerminalLifecycleMeta({ replayInvalid, livenessState: "blocked" });
  return buildEmbeddedRunBlockedResult({
    text,
    errorKind,
    errorMessage: errorText,
    durationMs: Date.now() - input.startedAtMs,
    agentMeta: input.buildErrorAgentMeta(),
    attempt: input.attempt,
    replayInvalid,
    finalPromptText: input.attempt.finalPromptText,
  });
}
