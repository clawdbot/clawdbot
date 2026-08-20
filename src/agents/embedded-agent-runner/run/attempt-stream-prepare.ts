/**
 * Prepares stream subscription, tool execution, and the active run queue.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { captureAgentRunLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { recordStructuredReplayTrustForToolCall } from "../../agent-tools.before-tool-call.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { cancelPendingAgentQuestionForSession } from "../../harness/gateway-question.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../harness/lifecycle-hook-helpers.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  isAgentRunRestartAbortReason,
} from "../../run-termination.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import { isToolResultError } from "../../tool-result-error.js";
import {
  projectToolSearchTargetTranscriptMessages,
  type ToolSearchCatalogToolExecutor,
  type ToolSearchTargetTranscriptProjection,
} from "../../tool-search.js";
import { log } from "../logger.js";
import { setActiveEmbeddedRunLifecycleGeneration } from "../run-state.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  setActiveEmbeddedRun,
} from "../runs.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  type AsyncStartedToolMeta,
} from "./attempt-async-tasks.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "./attempt-queue-message.js";
import type { EmbeddedAttemptClientToolCallSlot } from "./attempt-result.js";
import {
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveReportedModelRef,
} from "./helpers.js";
import { notifyToolActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type StreamRunState = {
  aborted: boolean;
  promptError: unknown;
  timedOut: boolean;
  yieldDetected: boolean;
};

type AttemptStreamQueueHandle = EmbeddedAgentQueueHandle & {
  kind: "embedded";
  cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
};

export function prepareEmbeddedAttemptStream(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  runtimeChannel?: string;
  hookRunner: HookRunner;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  clientToolCallSlots: readonly EmbeddedAttemptClientToolCallSlot[];
  toolSearchTargetTranscriptProjections: ToolSearchTargetTranscriptProjection[];
  isReplaySafeTool: (tool: Parameters<ToolSearchCatalogToolExecutor>[0]["tool"]) => boolean;
  runAbortController: AbortController;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  getRunState: () => StreamRunState;
  hasDeliveredSourceReply: () => boolean;
  markSourceReplyDelivered: () => void;
  onBlockReply: EmbeddedRunAttemptParams["onBlockReply"];
  onBlockReplyFlush: EmbeddedRunAttemptParams["onBlockReplyFlush"];
  sandboxSessionKey: string;
  builtinToolNames: ReadonlySet<string>;
  coreBuiltinToolNames?: ReadonlySet<string>;
  replaySafeToolNames: ReadonlySet<string>;
  sideEffectToolOwners?: ReadonlyMap<string, string>;
  diagnosticOwner: DiagnosticEmbeddedRunOwner;
}) {
  const attempt = input.attempt;
  const hookRunner = input.hookRunner;
  let beforeAgentFinalizeRevisionReason: string | undefined;
  let beforeAgentFinalizeRevisionEntryId: string | undefined;
  let acceptingSteerMessages = true;
  let activeQueueAdmissions = 0;
  const shouldRunBeforeAgentFinalize =
    attempt.operation !== "settled-tool-finalization" &&
    hookRunner?.hasHooks("before_agent_finalize");
  const onBeforeTerminalDelivery = shouldRunBeforeAgentFinalize
    ? async (event: {
        messages: AgentMessage[];
        willRetry: boolean;
        assistantEntryId?: string;
        lastAssistant?: AgentMessage;
        assistantTexts: readonly string[];
        hasAssistantVisibleText: boolean;
        isError: boolean;
        incompleteTerminalAssistant: boolean;
        hadDeterministicSideEffect: boolean;
      }): Promise<void | { suppressTerminalDelivery: true }> => {
        if (
          beforeAgentFinalizeRevisionReason ||
          event.willRetry ||
          event.isError ||
          event.incompleteTerminalAssistant ||
          !event.hasAssistantVisibleText
        ) {
          return;
        }
        const lastAssistant = event.lastAssistant as AssistantMessage | undefined;
        const lastAssistantMessage =
          normalizeOptionalString(resolveFinalAssistantVisibleText(lastAssistant)) ??
          normalizeOptionalString(resolveFinalAssistantRawText(lastAssistant)) ??
          normalizeOptionalString(event.assistantTexts.join("\n\n"));
        if (!lastAssistantMessage) {
          return;
        }
        const state = input.getRunState();
        const hasCompletedClientToolCall = input.clientToolCallSlots.some((slot) => slot.completed);
        const silentFinalReply =
          attempt.silentExpected && isSilentReplyText(lastAssistantMessage, SILENT_REPLY_TOKEN);
        if (
          state.aborted ||
          state.promptError ||
          state.timedOut ||
          hasCompletedClientToolCall ||
          state.yieldDetected ||
          silentFinalReply
        ) {
          return;
        }
        const hookMessages = projectToolSearchTargetTranscriptMessages(
          input.activeSession.messages.slice(),
          input.toolSearchTargetTranscriptProjections,
        );
        const reportedModelRef = resolveReportedModelRef({
          provider: attempt.provider,
          model: attempt.modelId,
          assistant: lastAssistant,
        });
        const maxRevisionAttempts = attempt.maxBeforeAgentFinalizeRevisions ?? 0;
        if (
          maxRevisionAttempts > 0 &&
          (attempt.beforeAgentFinalizeRevisionAttempts ?? 0) >= maxRevisionAttempts
        ) {
          log.warn(
            `before_agent_finalize revision limit reached; finalizing ` +
              `runId=${attempt.runId} sessionId=${attempt.sessionId} ` +
              `attempts=${attempt.beforeAgentFinalizeRevisionAttempts ?? 0}/${maxRevisionAttempts}`,
          );
          return;
        }
        // A queued user message wins over finalization. Close admission before
        // awaiting the hook so no later steer can become a child of the draft.
        acceptingSteerMessages = false;
        if (
          activeQueueAdmissions > 0 ||
          input.activeSession.pendingMessageCount > 0 ||
          input.activeSession.agent.hasQueuedMessages()
        ) {
          acceptingSteerMessages = true;
          return;
        }
        let keepAdmissionClosed = false;
        try {
          const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
            event: {
              runId: attempt.runId,
              sessionId: attempt.sessionId,
              ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
              provider: reportedModelRef.provider,
              model: reportedModelRef.model,
              ...((attempt.cwd ?? attempt.workspaceDir)
                ? { cwd: attempt.cwd ?? attempt.workspaceDir }
                : {}),
              ...(attempt.sessionFile ? { transcriptPath: attempt.sessionFile } : {}),
              stopHookActive: false,
              lastAssistantMessage,
              messages: hookMessages,
            },
            ctx: {
              runId: attempt.runId,
              trace: freezeDiagnosticTraceContext(input.diagnosticTrace),
              agentId: input.hookAgentId,
              sessionKey: attempt.sessionKey,
              sessionId: attempt.sessionId,
              workspaceDir: attempt.workspaceDir,
              modelProviderId: reportedModelRef.provider,
              modelId: reportedModelRef.model,
              trigger: attempt.trigger,
              ...buildAgentHookContextChannelFields(attempt),
              ...buildAgentHookContextIdentityFields({
                trigger: attempt.trigger,
                senderId: attempt.senderId,
                chatId: attempt.chatId,
                channelContext: attempt.channelContext,
              }),
            },
            hookRunner,
          });
          if (outcome.action !== "revise") {
            return;
          }
          if (event.hadDeterministicSideEffect) {
            log.warn(
              `before_agent_finalize requested revision after potential side effects; finalizing ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
            );
            return;
          }
          if (!event.assistantEntryId) {
            log.warn(
              `before_agent_finalize revision lacks a persisted assistant entry; finalizing ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
            );
            return;
          }
          keepAdmissionClosed = true;
          beforeAgentFinalizeRevisionEntryId = event.assistantEntryId;
          beforeAgentFinalizeRevisionReason = outcome.reason;
          return { suppressTerminalDelivery: true };
        } finally {
          if (!keepAdmissionClosed) {
            acceptingSteerMessages = true;
          }
        }
      }
    : undefined;

  let toolMetasForTerminal: readonly AsyncStartedToolMeta[] = [];
  // Terminal callbacks run after queue construction; keep the queue in this
  // phase so active-run clearing and subscription teardown share one owner.
  const getQueueHandle = (): AttemptStreamQueueHandle => queueHandle;
  const subscription = subscribeEmbeddedAgentSession({
    session: input.activeSession,
    runId: attempt.runId,
    lifecycleGeneration: attempt.lifecycleGeneration,
    messageChannel: input.runtimeChannel,
    initialReplayState: attempt.initialReplayState,
    hookRunner: getGlobalHookRunner() ?? undefined,
    verboseLevel: attempt.verboseLevel,
    reasoningMode: attempt.reasoningLevel ?? "off",
    thinkingLevel: attempt.thinkLevel,
    toolResultFormat: attempt.toolResultFormat,
    shouldEmitToolResult: attempt.shouldEmitToolResult,
    shouldEmitToolOutput: attempt.shouldEmitToolOutput,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    hasDeliveredMessageToolOnlySourceReply: input.hasDeliveredSourceReply,
    onDeliveredMessageToolOnlySourceReply: input.markSourceReplyDelivered,
    onAgentToolResult: attempt.onAgentToolResult,
    observeToolTerminal: attempt.observeToolTerminal,
    onToolResult: attempt.onToolResult,
    onReasoningStream: attempt.onReasoningStream,
    streamReasoningInNonStreamModes: attempt.streamReasoningInNonStreamModes,
    onReasoningEnd: attempt.onReasoningEnd,
    onBlockReply: input.onBlockReply,
    onBlockReplyFlush: input.onBlockReplyFlush,
    onBeforeTerminalDelivery,
    blockReplyBreak: attempt.blockReplyBreak,
    blockReplyChunking: attempt.blockReplyChunking,
    onPartialReply: attempt.onPartialReply,
    onAssistantMessageStart: attempt.onAssistantMessageStart,
    onExecutionPhase: attempt.onExecutionPhase,
    onAgentEvent: attempt.onAgentEvent,
    terminalLifecyclePhase: attempt.deferTerminalLifecycle ? "finishing" : "end",
    onToolStreamBoundary: attempt.onToolStreamBoundary,
    isTerminalAborted: () => input.getRunState().aborted,
    resolveTerminalStopReason: () =>
      isAgentRunRestartAbortReason(input.runAbortController.signal.reason)
        ? AGENT_RUN_RESTART_ABORT_STOP_REASON
        : undefined,
    onBeforeLifecycleTerminal: () => {
      if (
        requiresCompletionRequiredAsyncTaskWait({
          sessionKey: attempt.sessionKey,
          toolMetas: toolMetasForTerminal,
        })
      ) {
        return;
      }
      // Clear embedded-run activity before emitting terminal lifecycle events so
      // post-completion cleanup does not observe a logically finished run as active.
      clearActiveEmbeddedRun(
        attempt.sessionId,
        getQueueHandle(),
        attempt.sessionKey,
        attempt.sessionFile,
      );
    },
    enforceFinalTag: attempt.enforceFinalTag,
    silentExpected: attempt.silentExpected,
    suppressLiveStreamOutput: attempt.suppressLiveStreamOutput,
    config: attempt.config,
    // Live events belong to the transcript session. The sandbox key is only
    // authority context and may intentionally point at a visible parent.
    sessionKey: attempt.sessionKey,
    currentChannelId: attempt.currentChannelId,
    currentMessagingTarget: attempt.currentMessagingTarget,
    currentThreadId: attempt.currentThreadTs,
    currentMessageId: attempt.currentMessageId,
    replyToMode: attempt.replyToMode,
    hasRepliedRef: attempt.hasRepliedRef,
    sessionId: attempt.sessionId,
    agentId: input.hookAgentId,
    builtinToolNames: input.builtinToolNames,
    coreBuiltinToolNames: input.coreBuiltinToolNames,
    replaySafeToolNames: input.replaySafeToolNames,
    ...(input.sideEffectToolOwners ? { sideEffectToolOwners: input.sideEffectToolOwners } : {}),
    internalEvents: attempt.internalEvents,
  });
  toolMetasForTerminal = subscription.toolMetas;

  const toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor = async (toolParams) => {
    try {
      if (toolParams.source === "openclaw" && toolParams.sourceName === "core") {
        recordStructuredReplayTrustForToolCall(
          toolParams.toolCallId,
          toolParams.tool as never,
          attempt.runId,
        );
      }
      const result = await subscription.runToolLifecycle({
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        args: toolParams.input,
        replaySafe: input.isReplaySafeTool(toolParams.tool),
        hideFromChannelProgress:
          "hideFromChannelProgress" in toolParams.tool &&
          toolParams.tool.hideFromChannelProgress === true,
        execute: async () =>
          await toolParams.tool.execute(
            toolParams.toolCallId,
            toolParams.input,
            toolParams.signal ?? input.runAbortController.signal,
            toolParams.onUpdate,
            undefined as never,
          ),
      });
      // Settlement persists every queued projection. Validate the final result
      // first so a rejected hidden-tool value never enters session history.
      const acceptedResult = await toolParams.acceptResultBeforeProjection(result);
      const isError = isToolResultError(acceptedResult);
      input.toolSearchTargetTranscriptProjections.push({
        parentToolCallId: toolParams.parentToolCallId,
        toolCallId: toolParams.toolCallId,
        toolName: toolParams.toolName,
        input: toolParams.input,
        result: acceptedResult,
        // Fulfilled tools can still carry a canonical failure result (for example MCP isError).
        // Preserve that fact before the hidden target call is projected into session history.
        isError,
        timestamp: Date.now(),
      });
      notifyToolActivity(attempt.runId);
      return acceptedResult;
    } catch (error) {
      const message = formatErrorMessage(error);
      input.toolSearchTargetTranscriptProjections.push({
        parentToolCallId: toolParams.parentToolCallId,
        toolCallId: toolParams.toolCallId,
        toolName: toolParams.toolName,
        input: toolParams.input,
        result: {
          content: [{ type: "text", text: message }],
          details: { status: "error", error: message },
        },
        isError: true,
        timestamp: Date.now(),
      });
      notifyToolActivity(attempt.runId);
      throw error;
    }
  };

  let externalAbortAccepted = false;
  const abortActiveRunExternally = (reason?: "user_abort" | "restart" | "superseded") => {
    // Reply cancellation can synchronously re-enter through this same backend.
    // Latch before callbacks so the first reason owns every abort side effect.
    if (externalAbortAccepted) {
      return;
    }
    externalAbortAccepted = true;
    input.markExternalAbort();
    attempt.onAttemptAbort?.();
    const abortReason =
      reason === "restart"
        ? createAgentRunRestartAbortError()
        : reason === "superseded"
          ? createAgentRunSupersededAbortError()
          : undefined;
    input.abortRun(false, abortReason);
  };
  const queueMessage: AttemptStreamQueueHandle["queueMessage"] = async (text, options) => {
    const canInject = () =>
      acceptingSteerMessages &&
      !input.getRunState().aborted &&
      !input.runAbortController.signal.aborted;
    if (!canInject()) {
      throw new Error("active session is finalizing");
    }
    activeQueueAdmissions++;
    try {
      if (options?.steeringMode) {
        input.activeSession.agent.steeringMode = options.steeringMode;
      }
      return await steerActiveSessionWithOptionalDeliveryWait(
        input.activeSession,
        text,
        options,
        attempt.sessionKey,
        canInject,
      );
    } finally {
      activeQueueAdmissions--;
    }
  };
  const heartbeatReplyOperation =
    attempt.replyOperation?.turnKind === "heartbeat" ? attempt.replyOperation : undefined;
  const queueHandle: AttemptStreamQueueHandle = {
    kind: "embedded",
    runId: attempt.runId,
    diagnosticOwner: input.diagnosticOwner,
    closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(input.diagnosticOwner),
    ...(attempt.toolAuthorityFingerprint
      ? { toolAuthorityFingerprint: attempt.toolAuthorityFingerprint }
      : {}),
    claimPendingUserInputAnswer: (text, options) =>
      claimEmbeddedPendingUserInputAnswer(text, options, attempt.sessionKey),
    cancelPendingUserInput: (resolvedBy) =>
      cancelPendingAgentQuestionForSession({ sessionKey: attempt.sessionKey, resolvedBy }),
    preemptByVisibleTurn: heartbeatReplyOperation
      ? () => heartbeatReplyOperation.supersede()
      : undefined,
    queueMessage,
    messageInjection: {
      isAvailable: () =>
        acceptingSteerMessages &&
        !input.getRunState().aborted &&
        !input.runAbortController.signal.aborted,
      queueMessage,
    },
    isStreaming: () => input.activeSession.isStreaming,
    isAborted: () => input.getRunState().aborted,
    isStopped: () =>
      !acceptingSteerMessages ||
      input.getRunState().aborted ||
      input.runAbortController.signal.aborted,
    isCompacting: () => subscription.isCompacting(),
    supportsTranscriptCommitWait: true,
    supportsQueueMessageImages: true,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: attempt.taskSuggestionDeliveryMode,
    cancel: abortActiveRunExternally,
    abort: (reason) => abortActiveRunExternally(reason),
  };
  attempt.replyOperation?.attachBackend(queueHandle);
  setActiveEmbeddedRunLifecycleGeneration(
    queueHandle,
    attempt.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(attempt.runId),
  );
  setActiveEmbeddedRun(attempt.sessionId, queueHandle, attempt.sessionKey, attempt.sessionFile);

  return {
    subscription,
    queueHandle,
    toolSearchCatalogExecutor,
    getBeforeAgentFinalizeRevisionReason: () => beforeAgentFinalizeRevisionReason,
    getBeforeAgentFinalizeRevisionEntryId: () => beforeAgentFinalizeRevisionEntryId,
    stopAcceptingSteerMessages: () => {
      acceptingSteerMessages = false;
    },
  };
}
