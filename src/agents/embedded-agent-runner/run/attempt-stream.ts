/**
 * Installs replay, tool-call, timeout, and diagnostic guards around an embedded stream.
 */
import type { OpenAIResponsesCompactionRejection } from "@openclaw/ai/transports";
import { resolveDiagnosticModelContentCapturePolicy } from "../../../infra/diagnostic-llm-content.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../../../infra/net/undici-global-dispatcher.js";
import type { DiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import type { StreamFn } from "../../runtime/index.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import { wrapStreamFnCodeModeSource } from "../../transcript-code-mode-source.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import type { NormalizedUsage } from "../../usage.js";
import { log } from "../logger.js";
import { createPromptCacheRequestObserver } from "../prompt-cache-request-observer.js";
import {
  repairRejectedCompactionReplayInSessionManager,
  repairRejectedThinkingReplayInSessionManager,
} from "../thinking-replay-repair.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  wrapAnthropicStreamWithRecovery,
} from "../thinking.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import {
  createYieldAbortedResponse,
  isSessionsYieldAbortReason,
} from "./attempt-sessions-yield.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt-stop-reason-recovery.js";
import {
  sanitizeOpenAIResponsesReplayForStream,
  sanitizeReplayToolCallIdsForStream,
  shouldApplyReplayToolCallIdSanitizer,
  wrapStreamFnSanitizeMalformedToolCalls,
} from "./attempt-tool-call-replay-sanitization.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";

type CompactionReplayStreamOptions = NonNullable<Parameters<StreamFn>[2]> & {
  onCompactionRejected?: (checkpoint: OpenAIResponsesCompactionRejection) => void;
};

function wrapStreamFnWithCompactionReplayRepair(
  streamFn: StreamFn,
  onRejected: (checkpoint: OpenAIResponsesCompactionRejection) => void,
): StreamFn {
  return (model, context, options) => {
    const replayOptions = options as CompactionReplayStreamOptions | undefined;
    const nextOptions: CompactionReplayStreamOptions = {
      ...options,
      onCompactionRejected: (checkpoint) => {
        onRejected(checkpoint);
        if (replayOptions?.onCompactionRejected) {
          replayOptions.onCompactionRejected(checkpoint);
        }
      },
    };
    return streamFn(model, context, nextOptions);
  };
}

export function installEmbeddedAttemptStreamGuards(
  input: EmbeddedAttemptExecutionPhaseInput,
  callbacks: {
    onRejectedProviderReplayRepaired: () => void;
    onIdleTimeout: (error: Error) => void;
    diagnosticOwner: DiagnosticEmbeddedRunOwner;
  },
) {
  const { attempt } = input;
  const {
    agentSession: { activeSession: session, codeModeExecToolNames },
    anthropicPayloadLogger,
    cacheTrace,
    contextGuards,
    isOpenAIResponsesApi,
    sessionManager,
    state: { systemPromptText },
    transcriptPolicy,
    transport: {
      effectiveAgentTransport,
      effectivePromptCacheRetention,
      streamStrategy,
      providerTextTransforms,
    },
  } = input.prepared.sessionRuntime;
  const { liveAllowedToolNames, replayAllowedToolNames } =
    input.prepared.toolCatalog.toolSearchRunPlan;
  const { sessionAgentId } = input.setup;
  const { signal: abortSignal } = input.runAbortController;
  const repairRejectedReplay = (
    kind: "compaction" | "thinking",
    checkpoint?: OpenAIResponsesCompactionRejection,
  ) => {
    try {
      const repairParams = {
        sessionManager,
        sessionFile: attempt.sessionFile,
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: sessionAgentId,
      };
      let repair;
      if (kind === "compaction") {
        if (!checkpoint) {
          log.warn(
            `[session-recovery] unable to repair rejected compaction replay: ` +
              `checkpoint identity unavailable sessionId=${session.sessionId}`,
          );
          return;
        }
        repair = repairRejectedCompactionReplayInSessionManager({ ...repairParams, checkpoint });
      } else {
        repair = repairRejectedThinkingReplayInSessionManager(repairParams);
      }
      if (repair.repaired) {
        callbacks.onRejectedProviderReplayRepaired();
        return;
      }
      log.warn(
        `[session-recovery] provider rejected ${kind} replay but transcript repair made no changes: ` +
          `sessionId=${session.sessionId} reason=${repair.reason ?? "unknown"}`,
      );
    } catch (error) {
      log.warn(
        `[session-recovery] unable to repair rejected ${kind} replay: ` +
          `sessionId=${session.sessionId} error=${String(error)}`,
      );
    }
  };
  const cacheObservabilityEnabled = Boolean(cacheTrace) || log.isEnabled("debug");
  const cacheObserver = cacheObservabilityEnabled
    ? createPromptCacheRequestObserver(
        {
          sessionId: attempt.sessionId,
          sessionKey: attempt.sessionKey,
          promptCacheKey: attempt.promptCacheKey,
          cacheRetention: effectivePromptCacheRetention,
          streamStrategy,
          transport: effectiveAgentTransport,
        },
        (observation, snapshot) => {
          if (observation.broke) {
            const changes =
              observation.changes?.map((change) => `${change.code}(${change.detail})`).join(", ") ??
              "no tracked cache input change";
            log.warn(
              `[prompt-cache] cache read dropped ${observation.previousCacheRead} -> ${observation.cacheRead} ` +
                `runId=${attempt.runId} request=${observation.requestIndex} for ${snapshot.provider}/${snapshot.modelId} via ${streamStrategy}; ${changes}`,
            );
          }
          cacheTrace?.recordStage("cache:result", { options: { ...observation } });
        },
        (request) => {
          cacheTrace?.recordStage("cache:state", {
            options: { ...request, previousCacheRead: request.previousCacheRead ?? undefined },
          });
        },
      )
    : undefined;
  if (cacheTrace) {
    cacheTrace.recordStage("session:loaded", {
      messages: session.messages,
      system: systemPromptText,
      note: "after session create",
    });
    session.agent.streamFn = cacheTrace.wrapStreamFn(session.agent.streamFn);
  }

  // Anthropic Claude endpoints can reject replayed `thinking` blocks on
  // any follow-up provider call, including tool continuations. Sanitize
  // outbound messages where policy allows rewriting; otherwise preserve
  // latest thinking and let the recovery wrapper retry once without it.
  if (transcriptPolicy.dropThinkingBlocks || transcriptPolicy.dropReasoningFromHistory) {
    session.agent.streamFn = wrapStreamFnWithMessageTransform(
      session.agent.streamFn,
      (messages) => {
        const reasoningSanitized = transcriptPolicy.dropReasoningFromHistory
          ? dropReasoningFromHistory(messages)
          : messages;
        return transcriptPolicy.dropThinkingBlocks
          ? dropThinkingBlocks(reasoningSanitized)
          : reasoningSanitized;
      },
    );
  }
  if (
    transcriptPolicy.preserveSignatures ||
    transcriptPolicy.dropThinkingBlocks ||
    transcriptPolicy.dropReasoningFromHistory
  ) {
    session.agent.streamFn = wrapAnthropicStreamWithRecovery(session.agent.streamFn, {
      id: session.sessionId,
      onRecoveredAnthropicThinking: () => repairRejectedReplay("thinking"),
    });
  }

  // Mistral (and other strict providers) reject tool call IDs that don't match their
  // format requirements (e.g. [a-zA-Z0-9]{9}). sanitizeSessionHistory only processes
  // historical messages at attempt start, but the agent loop's internal tool call →
  // tool result cycles bypass that path. Wrap streamFn so every outbound request
  // sees sanitized tool call IDs.
  const replayToolCallIdSanitizerDecision = {
    sanitizeToolCallIds: transcriptPolicy.sanitizeToolCallIds,
    toolCallIdMode: transcriptPolicy.toolCallIdMode,
    isOpenAIResponsesApi,
  };
  if (shouldApplyReplayToolCallIdSanitizer(replayToolCallIdSanitizerDecision)) {
    const mode = replayToolCallIdSanitizerDecision.toolCallIdMode;
    session.agent.streamFn = wrapStreamFnWithMessageTransform(
      session.agent.streamFn,
      (messages, model) =>
        sanitizeReplayToolCallIdsForStream({
          messages,
          mode,
          allowedToolNames: replayAllowedToolNames,
          preserveNativeAnthropicToolUseIds: transcriptPolicy.preserveNativeAnthropicToolUseIds,
          duplicateToolCallIdStyle: transcriptPolicy.duplicateToolCallIdStyle,
          preserveReplaySafeThinkingToolCallIds: shouldAllowProviderOwnedThinkingReplay({
            modelApi: (model as { api?: unknown })?.api as string | null | undefined,
            provider: attempt.provider,
            policy: transcriptPolicy,
          }),
          repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
        }),
    );
  }

  if (isOpenAIResponsesApi) {
    session.agent.streamFn = wrapStreamFnWithCompactionReplayRepair(
      session.agent.streamFn,
      (checkpoint) => repairRejectedReplay("compaction", checkpoint),
    );
    session.agent.streamFn = wrapStreamFnWithMessageTransform(session.agent.streamFn, (messages) =>
      sanitizeOpenAIResponsesReplayForStream(messages),
    );
  }

  const innerStreamFn = session.agent.streamFn;
  session.agent.streamFn = (model, context, options) => {
    const signal = abortSignal;
    if (
      input.lifecycle.readYieldState().yieldDetected &&
      signal.aborted &&
      isSessionsYieldAbortReason(signal.reason)
    ) {
      return createYieldAbortedResponse(model);
    }
    return innerStreamFn(model, context, options);
  };

  // Some models emit tool names with surrounding whitespace (e.g. " read ").
  // agent runtime dispatches tool calls with exact string matching, so normalize
  // names on the live response stream before tool execution.
  session.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
    session.agent.streamFn,
    replayAllowedToolNames,
    transcriptPolicy,
    attempt.provider,
  );
  session.agent.streamFn = wrapStreamFnPromoteStandaloneTextToolCalls(
    session.agent.streamFn,
    liveAllowedToolNames,
  );
  session.agent.streamFn = wrapStreamFnTrimToolCallNames(
    session.agent.streamFn,
    liveAllowedToolNames,
    {
      // Unknown-tool recovery stays active even when configurable loop detection is disabled.
      unknownToolThreshold: UNKNOWN_TOOL_THRESHOLD,
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
  if (providerTextTransforms?.output?.length) {
    session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: session.agent.streamFn,
      output: providerTextTransforms.output,
    });
  }

  if (anthropicPayloadLogger) {
    session.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(session.agent.streamFn);
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
  const timeoutOptions = {
    cfg: attempt.config,
    runTimeoutMs: resolvedRunTimeoutMs,
    modelRequestTimeoutMs: (attempt.model as { requestTimeoutMs?: number }).requestTimeoutMs,
    model: { baseUrl: attempt.model.baseUrl, id: attempt.modelId, provider: attempt.provider },
  };
  const idleTimeoutMs = resolveLlmIdleTimeoutMs({ ...timeoutOptions, trigger: attempt.trigger });
  const firstEventTimeoutMs = resolveLlmFirstEventTimeoutMs(timeoutOptions);
  if (idleTimeoutMs > 0) {
    session.agent.streamFn = streamWithIdleTimeout(
      session.agent.streamFn,
      idleTimeoutMs,
      (error) => callbacks.onIdleTimeout(error),
      { runId: attempt.runId },
    );
  } else if (firstEventTimeoutMs > 0) {
    // Local providers opt out of gap policing, but the transport first-event
    // guard only arms after stream creation. A request whose headers never
    // arrive would otherwise wedge until the run budget with no watchdog.
    session.agent.streamFn = streamWithIdleTimeout(
      session.agent.streamFn,
      firstEventTimeoutMs,
      (error) => callbacks.onIdleTimeout(error),
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
        onFirstEventTimeout: optionsWithFirstEvent?.onFirstEventTimeout ?? callbacks.onIdleTimeout,
      } as typeof options);
    };
  }
  let diagnosticModelCallSeq = 0;
  let modelResponseTerminal = false;
  session.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(session.agent.streamFn, {
    runId: attempt.runId,
    ...(attempt.sessionKey && { sessionKey: attempt.sessionKey }),
    ...(attempt.sessionId && { sessionId: attempt.sessionId }),
    provider: attempt.provider,
    model: attempt.modelId,
    api: attempt.model.api,
    transport: effectiveAgentTransport,
    // No-gap local inference remains recoverable at its existing transport deadline.
    requestTimeoutMs:
      idleTimeoutMs || Math.min(attempt.timeoutMs, DEFAULT_UNDICI_STREAM_TIMEOUT_MS),
    ...(attempt.contextWindowInfo?.tokens
      ? { contextTokenBudget: attempt.contextWindowInfo.tokens }
      : {}),
    ...(attempt.contextWindowInfo?.source
      ? { contextWindowSource: attempt.contextWindowInfo.source }
      : {}),
    ...(attempt.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: attempt.contextWindowInfo.referenceTokens }
      : {}),
    trace: input.diagnostics.runTrace,
    contentCapture: resolveDiagnosticModelContentCapturePolicy(attempt.config),
    nextCallId: () => `${attempt.runId}:model:${(diagnosticModelCallSeq += 1)}`,
    ownerGeneration: callbacks.diagnosticOwner.generation,
    onSucceeded: contextGuards.recordCacheTouch,
    onTerminal: () => {
      modelResponseTerminal = true;
    },
    onStarted: () => {
      modelResponseTerminal = false;
      attempt.onExecutionPhase?.({
        phase: "model_call_started",
        provider: attempt.provider,
        model: attempt.modelId,
        firstModelCallStarted: true,
      });
    },
    suppressPluginHooks: attempt.operation === "settled-tool-finalization",
  });
  if (codeModeExecToolNames?.size) {
    session.agent.streamFn = wrapStreamFnCodeModeSource(
      session.agent.streamFn,
      codeModeExecToolNames,
    );
  }
  return {
    onModelRequest: cacheObserver?.onModelRequest,
    onModelUsage: cacheObserver
      ? (usage: NormalizedUsage | undefined) => {
          // Async-tool fragments also end messages. result() marks the terminal
          // response before core commits its final fragment with normalized usage.
          if (modelResponseTerminal) {
            modelResponseTerminal = false;
            cacheObserver.onModelUsage(usage);
          }
        }
      : undefined,
    getPromptCacheObservation: cacheObserver?.getObservation,
  };
}
