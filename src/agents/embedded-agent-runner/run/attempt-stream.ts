/**
 * Installs replay, tool-call, timeout, and diagnostic guards around an embedded stream.
 */
import { resolveDiagnosticModelContentCapturePolicy } from "../../../infra/diagnostic-llm-content.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import type { resolveProviderTextTransforms } from "../../../plugins/provider-runtime.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { createCacheTrace } from "../../cache-trace.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import { log } from "../logger.js";
import { collectPromptCacheToolNames } from "../prompt-cache-observability.js";
import { repairRejectedThinkingReplayInSessionManager } from "../thinking-replay-repair.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  wrapAnthropicStreamWithRecovery,
} from "../thinking.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import { resolveUnknownToolGuardThreshold } from "./attempt.run-decisions.js";
import type { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import {
  createYieldAbortedResponse,
  isSessionsYieldAbortReason,
} from "./attempt.sessions-yield.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt.stop-reason-recovery.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  sanitizeOpenAIResponsesReplayForStream,
  sanitizeReplayToolCallIdsForStream,
  shouldApplyReplayToolCallIdSanitizer,
  wrapStreamFnPromoteStandaloneTextToolCalls,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type CacheTrace = ReturnType<typeof createCacheTrace>;
type AnthropicPayloadLogger = ReturnType<typeof createAnthropicPayloadLogger>;
type AttemptSessionLockController = Awaited<
  ReturnType<typeof createEmbeddedAttemptSessionLockController>
>;

export function installEmbeddedAttemptStreamGuards(input: {
  attempt: EmbeddedRunAttemptParams;
  session: AgentSession;
  sessionAgentId: string;
  cacheTrace: CacheTrace;
  allCustomTools: Array<{ name?: string }>;
  systemPromptText: string;
  transcriptPolicy: TranscriptPolicy;
  sessionManager: SessionManager | undefined;
  sessionLockController: AttemptSessionLockController;
  isOpenAIResponsesApi: boolean;
  replayAllowedToolNames: Set<string>;
  liveAllowedToolNames: Set<string>;
  isYieldDetected: () => boolean;
  clientToolLoopDetection: ReturnType<
    typeof import("../../agent-tools.js").resolveToolLoopDetectionConfig
  >;
  anthropicPayloadLogger: AnthropicPayloadLogger;
  onRejectedThinkingReplayRepaired: () => void;
  onIdleTimeout: (error: Error) => void;
  effectiveAgentTransport: AgentSession["agent"]["transport"];
  providerTextTransforms: ReturnType<typeof resolveProviderTextTransforms>;
  abortSignal: AbortSignal;
  runTrace: DiagnosticTraceContext;
}) {
  const attempt = input.attempt;
  const session = input.session;
  const cacheObservabilityEnabled = Boolean(input.cacheTrace) || log.isEnabled("debug");
  const promptCacheToolNames = collectPromptCacheToolNames(
    input.allCustomTools as Array<{ name?: string }>,
  );
  if (input.cacheTrace) {
    input.cacheTrace.recordStage("session:loaded", {
      messages: session.messages,
      system: input.systemPromptText,
      note: "after session create",
    });
    session.agent.streamFn = input.cacheTrace.wrapStreamFn(session.agent.streamFn);
  }

  // Anthropic Claude endpoints can reject replayed `thinking` blocks on
  // any follow-up provider call, including tool continuations. Sanitize
  // outbound messages where policy allows rewriting; otherwise preserve
  // latest thinking and let the recovery wrapper retry once without it.
  if (
    input.transcriptPolicy.dropThinkingBlocks ||
    input.transcriptPolicy.dropReasoningFromHistory
  ) {
    session.agent.streamFn = wrapStreamFnWithMessageTransform(
      session.agent.streamFn,
      (messages) => {
        const reasoningSanitized = input.transcriptPolicy.dropReasoningFromHistory
          ? dropReasoningFromHistory(messages)
          : messages;
        return input.transcriptPolicy.dropThinkingBlocks
          ? dropThinkingBlocks(reasoningSanitized)
          : reasoningSanitized;
      },
    );
  }
  if (
    input.transcriptPolicy.preserveSignatures ||
    input.transcriptPolicy.dropThinkingBlocks ||
    input.transcriptPolicy.dropReasoningFromHistory
  ) {
    session.agent.streamFn = wrapAnthropicStreamWithRecovery(session.agent.streamFn, {
      id: session.sessionId,
      onRecoveredAnthropicThinking: () => {
        if (!input.sessionManager) {
          log.warn(
            `[session-recovery] unable to repair rejected thinking replay: session manager unavailable sessionId=${session.sessionId}`,
          );
          return;
        }
        const repair = repairRejectedThinkingReplayInSessionManager({
          sessionManager: input.sessionManager,
          sessionFile: attempt.sessionFile,
          sessionId: attempt.sessionId,
          sessionKey: attempt.sessionKey,
          agentId: input.sessionAgentId,
        });
        if (repair.repaired) {
          input.onRejectedThinkingReplayRepaired();
          input.sessionLockController.refreshAfterOwnedSessionWrite();
          return;
        }
        log.warn(
          `[session-recovery] rejected thinking replay retry succeeded but transcript repair made no changes: ` +
            `sessionId=${session.sessionId} reason=${repair.reason ?? "unknown"}`,
        );
      },
    });
  }

  // Mistral (and other strict providers) reject tool call IDs that don't match their
  // format requirements (e.g. [a-zA-Z0-9]{9}). sanitizeSessionHistory only processes
  // historical messages at attempt start, but the agent loop's internal tool call →
  // tool result cycles bypass that path. Wrap streamFn so every outbound request
  // sees sanitized tool call IDs.
  const replayToolCallIdSanitizerDecision = {
    sanitizeToolCallIds: input.transcriptPolicy.sanitizeToolCallIds,
    toolCallIdMode: input.transcriptPolicy.toolCallIdMode,
    isOpenAIResponsesApi: input.isOpenAIResponsesApi,
  };
  if (shouldApplyReplayToolCallIdSanitizer(replayToolCallIdSanitizerDecision)) {
    const mode = replayToolCallIdSanitizerDecision.toolCallIdMode;
    session.agent.streamFn = wrapStreamFnWithMessageTransform(
      session.agent.streamFn,
      (messages, model) =>
        sanitizeReplayToolCallIdsForStream({
          messages,
          mode,
          allowedToolNames: input.replayAllowedToolNames,
          preserveNativeAnthropicToolUseIds:
            input.transcriptPolicy.preserveNativeAnthropicToolUseIds,
          duplicateToolCallIdStyle: input.transcriptPolicy.duplicateToolCallIdStyle,
          preserveReplaySafeThinkingToolCallIds: shouldAllowProviderOwnedThinkingReplay({
            modelApi: (model as { api?: unknown })?.api as string | null | undefined,
            provider: attempt.provider,
            policy: input.transcriptPolicy,
          }),
          repairToolUseResultPairing: input.transcriptPolicy.repairToolUseResultPairing,
        }),
    );
  }

  if (input.isOpenAIResponsesApi) {
    session.agent.streamFn = wrapStreamFnWithMessageTransform(session.agent.streamFn, (messages) =>
      sanitizeOpenAIResponsesReplayForStream(messages),
    );
  }

  const innerStreamFn = session.agent.streamFn;
  session.agent.streamFn = (model, context, options) => {
    const signal = input.abortSignal as AbortSignal & { reason?: unknown };
    if (input.isYieldDetected() && signal.aborted && isSessionsYieldAbortReason(signal.reason)) {
      return createYieldAbortedResponse(model) as unknown as Awaited<
        ReturnType<typeof innerStreamFn>
      >;
    }
    return innerStreamFn(model, context, options);
  };

  // Some models emit tool names with surrounding whitespace (e.g. " read ").
  // agent runtime dispatches tool calls with exact string matching, so normalize
  // names on the live response stream before tool execution.
  session.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
    session.agent.streamFn,
    input.replayAllowedToolNames,
    input.transcriptPolicy,
    attempt.provider,
  );
  session.agent.streamFn = wrapStreamFnPromoteStandaloneTextToolCalls(
    session.agent.streamFn,
    input.liveAllowedToolNames,
  );
  session.agent.streamFn = wrapStreamFnTrimToolCallNames(
    session.agent.streamFn,
    input.liveAllowedToolNames,
    {
      unknownToolThreshold: resolveUnknownToolGuardThreshold(input.clientToolLoopDetection),
    },
  );

  if (
    shouldRepairMalformedToolCallArguments({
      provider: attempt.provider,
      modelApi: attempt.model.api,
    })
  ) {
    session.agent.streamFn = wrapStreamFnRepairMalformedToolCallArguments(session.agent.streamFn);
  }

  if (resolveToolCallArgumentsEncoding(attempt.model) === "html-entities") {
    session.agent.streamFn = wrapStreamFnDecodeXaiToolCallArguments(session.agent.streamFn);
  }

  // Tool-call repair can replace structured arguments from fragmented deltas.
  // Restore provider-masked text afterward so executable args stay canonical.
  if (input.providerTextTransforms?.output?.length) {
    session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: session.agent.streamFn,
      output: input.providerTextTransforms.output,
    });
  }

  if (input.anthropicPayloadLogger) {
    session.agent.streamFn = input.anthropicPayloadLogger.wrapStreamFn(session.agent.streamFn);
  }
  // Anthropic-compatible providers can add new stop reasons before shared model runtime maps them.
  // Recover the known "sensitive" stop reason here so a model refusal does not
  // bubble out as an uncaught runner error and stall channel polling.
  session.agent.streamFn = wrapStreamFnHandleSensitiveStopReason(session.agent.streamFn);

  // Wrap stream with idle timeout detection.
  //
  // Prefer the caller's explicit `runTimeoutOverrideMs` when provided —
  // it carries the "this run was launched with a deliberate per-run
  // timeout" signal without losing it when the value numerically equals
  // `agents.defaults.timeoutSeconds`. Fall back to the value-equality
  // heuristic for callers that haven't been migrated to plumb the flag.
  const configuredRunTimeoutMs = resolveAgentTimeoutMs({
    cfg: attempt.config,
  });
  const resolvedRunTimeoutMs =
    attempt.runTimeoutOverrideMs ??
    (attempt.timeoutMs !== configuredRunTimeoutMs ? attempt.timeoutMs : undefined);
  const idleTimeoutMs = resolveLlmIdleTimeoutMs({
    cfg: attempt.config,
    trigger: attempt.trigger,
    runTimeoutMs: resolvedRunTimeoutMs,
    modelRequestTimeoutMs: (attempt.model as { requestTimeoutMs?: number }).requestTimeoutMs,
    model: {
      baseUrl: attempt.model.baseUrl,
      id: attempt.modelId,
      provider: attempt.provider,
    },
  });
  const firstEventTimeoutMs = resolveLlmFirstEventTimeoutMs({
    cfg: attempt.config,
    runTimeoutMs: resolvedRunTimeoutMs,
    modelRequestTimeoutMs: (attempt.model as { requestTimeoutMs?: number }).requestTimeoutMs,
    model: {
      baseUrl: attempt.model.baseUrl,
      id: attempt.modelId,
      provider: attempt.provider,
    },
  });
  if (idleTimeoutMs > 0) {
    session.agent.streamFn = streamWithIdleTimeout(
      session.agent.streamFn,
      idleTimeoutMs,
      (error) => input.onIdleTimeout(error),
      { runId: attempt.runId },
    );
  } else if (firstEventTimeoutMs > 0) {
    // Local providers opt out of gap policing, but the transport first-event
    // guard only arms after stream creation. A request whose headers never
    // arrive would otherwise wedge until the run budget with no watchdog.
    session.agent.streamFn = streamWithIdleTimeout(
      session.agent.streamFn,
      firstEventTimeoutMs,
      (error) => input.onIdleTimeout(error),
      { runId: attempt.runId, scope: "creation-only" },
    );
  }
  if (firstEventTimeoutMs > 0) {
    const baseStreamFn = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => {
      type FirstEventStreamOptions = {
        firstEventTimeoutMs?: number;
        onFirstEventTimeout?: (error: Error) => void;
      };
      const optionsWithFirstEvent = options as FirstEventStreamOptions | undefined;
      return baseStreamFn(model, context, {
        ...options,
        firstEventTimeoutMs: optionsWithFirstEvent?.firstEventTimeoutMs ?? firstEventTimeoutMs,
        onFirstEventTimeout: optionsWithFirstEvent?.onFirstEventTimeout ?? input.onIdleTimeout,
      } as typeof options);
    };
  }
  let diagnosticModelCallSeq = 0;
  session.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(session.agent.streamFn, {
    runId: attempt.runId,
    ...(attempt.sessionKey && { sessionKey: attempt.sessionKey }),
    ...(attempt.sessionId && { sessionId: attempt.sessionId }),
    provider: attempt.provider,
    model: attempt.modelId,
    api: attempt.model.api,
    transport: input.effectiveAgentTransport,
    ...(attempt.contextWindowInfo?.tokens
      ? { contextTokenBudget: attempt.contextWindowInfo.tokens }
      : {}),
    ...(attempt.contextWindowInfo?.source
      ? { contextWindowSource: attempt.contextWindowInfo.source }
      : {}),
    ...(attempt.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: attempt.contextWindowInfo.referenceTokens }
      : {}),
    trace: input.runTrace,
    contentCapture: resolveDiagnosticModelContentCapturePolicy(attempt.config),
    nextCallId: () => `${attempt.runId}:model:${(diagnosticModelCallSeq += 1)}`,
    onStarted: () => {
      attempt.onExecutionPhase?.({
        phase: "model_call_started",
        provider: attempt.provider,
        model: attempt.modelId,
        firstModelCallStarted: true,
      });
    },
    suppressPluginHooks: attempt.operation === "settled-tool-finalization",
  });
  return {
    cacheObservabilityEnabled,
    promptCacheToolNames,
  };
}
