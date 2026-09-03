import { CompactionReplayRefreshRequiredError } from "@openclaw/ai/transports";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  type AgentRunAttemptFailureSource,
} from "../../agent-run-terminal-outcome.js";
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
  isCliTerminalStopCode,
  resolveFailoverStatus,
} from "../../failover-error.js";
import { resolveRetryAfterMs } from "../../failover/retry-evidence.js";
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
  suspendForFailure: (params: SessionSuspensionParams) => void;
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
  advanceAuthProfile: () => Promise<boolean>;
  advanceRateLimitAuthProfile: (context: {
    failoverProvider: string;
    failoverModel: string;
    logFallbackDecision: ReturnType<typeof createFailoverDecisionLogger>;
  }) => Promise<boolean>;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeRetryTransient: (retry: {
    reason: FailoverReason;
    retryAfterMs?: number;
  }) => Promise<boolean>;
  getTransientRetryCount: () => number;
  attemptedThinking: Set<ThinkLevel>;
  thinkLevel: ThinkLevel;
  // Profile rotation resets thinking inside the runtime; read it after advancing.
  getThinkLevel: () => ThinkLevel;
  traceAttempts: TraceAttempt[];
  previousRetryFailoverReason: FailoverReason | null;
}): Promise<PromptFailureOutcome> {
  // Only the local precheck owns this recovery; provider text cannot request it.
  if (
    input.promptErrorSource === "precheck" &&
    input.promptError instanceof CompactionReplayRefreshRequiredError
  ) {
    const text = new CompactionReplayRefreshRequiredError().message;
    return completeBlockedPromptFailure(input, {
      text,
      errorKind: "compaction_replay_refresh_required",
      errorMessage: text,
    });
  }
  const promptAuthMode = input.authProfileId
    ? input.authProfileStore.profiles?.[input.authProfileId]?.type
    : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcomeFromAttempt({
    terminal: input.attempt.terminal,
    promptTimeoutOutcome: input.attempt.promptTimeoutOutcome,
  });
  const failoverContext = {
    provider: input.activeErrorContext.provider,
    model: input.activeErrorContext.model,
    profileId: input.authProfileId,
    authMode: promptAuthMode,
    sessionId: input.sessionIdUsed,
    lane: input.lane,
    timeout:
      terminalOutcome.status === "timeout"
        ? {
            timeoutPhase: terminalOutcome.timeoutPhase,
            providerStarted: terminalOutcome.providerStarted,
          }
        : undefined,
  };
  const normalizedPromptFailover = coerceToFailoverError(input.promptError, failoverContext);
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
  // A recorded CLI terminal stop outranks every text-derived recovery below:
  // its message repeats a backend-controlled reason, so an auth-shaped value
  // would otherwise refresh and retry a turn whose tool effects already ran.
  const recordedTerminalStop = isCliTerminalStopCode(promptErrorDetails.code);
  if (
    !recordedTerminalStop &&
    (await input.maybeRefreshRuntimeAuthForAuthError(errorText, input.runtimeAuthRetry))
  ) {
    return {
      action: "retry",
      thinkLevel: input.thinkLevel,
      authRetryPending: true,
      lastRetryFailoverReason: input.previousRetryFailoverReason,
    };
  }

  const blockedResult = recordedTerminalStop
    ? undefined
    : resolveBlockedPromptResult(input, errorText);
  if (blockedResult) {
    return blockedResult;
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
    retryCount: input.getTransientRetryCount(),
    attemptCount: input.traceAttempts.length + 1,
  });
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
  const canRetryRateLimit =
    promptFailoverReason !== "rate_limit" || isShortWindowRateLimitMessage(errorText);
  if (
    !recordedTerminalStop &&
    !input.externalAbort &&
    canRetryRateLimit &&
    promptFailoverReason &&
    (failoverDecision.action === "rotate_profile" ||
      failoverDecision.action === "fallback_model" ||
      failoverDecision.action === "surface_error") &&
    (await input.maybeRetryTransient({
      reason: promptFailoverReason,
      retryAfterMs: resolveRetryAfterMs(errorText),
    }))
  ) {
    logFailoverDecision("retry_same_model", {
      retryCount: input.getTransientRetryCount(),
    });
    return {
      action: "retry",
      thinkLevel: input.thinkLevel,
      authRetryPending: false,
      lastRetryFailoverReason: mergeRetryFailoverReason({
        previous: input.previousRetryFailoverReason,
        failoverReason: promptFailoverReason,
      }),
    };
  }
  let rotated = false;
  if (failoverDecision.action === "rotate_profile") {
    if (promptFailoverReason === "rate_limit") {
      rotated = await input.advanceRateLimitAuthProfile({
        failoverProvider: input.provider,
        failoverModel: input.modelId,
        logFallbackDecision: logFailoverDecision,
      });
    } else {
      rotated = await input.advanceAuthProfile();
    }
  }
  if (rotated) {
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
    logFailoverDecision("rotate_profile", {
      retryCount: input.getTransientRetryCount(),
      profileRotationCount: rotated ? 1 : 0,
    });
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
  const fallbackThinking = recordedTerminalStop
    ? undefined
    : pickFallbackThinkingLevel({ message: errorText, attempted: input.attemptedThinking });
  if (fallbackThinking) {
    log.warn(
      `unsupported thinking level for ${input.provider}/${input.modelId}; retrying with ${fallbackThinking}`,
    );
    logFailoverDecision("retry_thinking_level", {
      retryCount: input.getTransientRetryCount(),
    });
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
    logFailoverDecision("fallback_model", {
      status,
      retryCount: input.getTransientRetryCount(),
      profileRotationCount: 0,
    });
    throw (
      (normalizedPromptFailover?.reason === fallbackReason ? normalizedPromptFailover : null) ??
      new FailoverError(errorText, {
        ...failoverContext,
        reason: fallbackReason,
        provider: input.provider,
        model: input.modelId,
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
    logFailoverDecision("surface_error", {
      retryCount: input.getTransientRetryCount(),
      profileRotationCount: 0,
    });
  }
  if (failoverContext.timeout) {
    throw (
      normalizedPromptFailover ??
      new FailoverError(errorText, {
        ...failoverContext,
        reason: "timeout",
        cause: input.promptError,
      })
    );
  }
  throw toErrorObject(input.promptError, "Prompt failed");
}

function resolveBlockedPromptResult(
  input: Parameters<typeof handleEmbeddedPromptFailure>[0],
  errorText: string,
): PromptFailureOutcome | undefined {
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
  return completeBlockedPromptFailure(input, { text, errorKind, errorMessage: errorText });
}

function completeBlockedPromptFailure(
  input: Parameters<typeof handleEmbeddedPromptFailure>[0],
  copy: Pick<
    Parameters<typeof buildEmbeddedRunBlockedResult>[0],
    "text" | "errorKind" | "errorMessage"
  >,
): PromptFailureOutcome {
  const replayInvalid = input.resolveReplayInvalid();
  input.setTerminalLifecycleMeta({ replayInvalid, livenessState: "blocked" });
  return {
    action: "complete",
    result: buildEmbeddedRunBlockedResult({
      ...copy,
      durationMs: Date.now() - input.startedAtMs,
      agentMeta: input.buildErrorAgentMeta(),
      attempt: input.attempt,
      replayInvalid,
      finalPromptText: input.attempt.finalPromptText,
    }),
  };
}
