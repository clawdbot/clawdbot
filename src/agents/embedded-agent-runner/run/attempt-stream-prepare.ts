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
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { recordStructuredReplayTrustForToolCall } from "../../agent-tools.before-tool-call.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../harness/lifecycle-hook-helpers.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../run-termination.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
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
import type { EmbeddedAttemptClientToolCallSlot } from "./attempt-result.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  type AsyncStartedToolMeta,
} from "./attempt.async-tasks.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt.queue-message.js";
import { buildEmbeddedSubscriptionParams } from "./attempt.subscription-cleanup.js";
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
  replaySafeToolNames: ReadonlySet<string>;
}) {
  const attempt = input.attempt;
  const hookRunner = input.hookRunner;
  let beforeAgentFinalizeRevisionReason: string | undefined;
  const shouldRunBeforeAgentFinalize =
    attempt.operation !== "settled-tool-finalization" &&
    hookRunner?.hasHooks("before_agent_finalize");
  const onBeforeTerminalDelivery = shouldRunBeforeAgentFinalize
    ? async (event: {
        messages: AgentMessage[];
        willRetry: boolean;
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
        beforeAgentFinalizeRevisionReason = outcome.reason;
        return { suppressTerminalDelivery: true };
      }
    : undefined;

  let toolMetasForTerminal: readonly AsyncStartedToolMeta[] = [];
  // Terminal callbacks run after queue construction; keep the queue in this
  // phase so active-run clearing and subscription teardown share one owner.
  const getQueueHandle = (): AttemptStreamQueueHandle => queueHandle;
  const subscription = subscribeEmbeddedAgentSession(
    buildEmbeddedSubscriptionParams({
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
      sessionKey: input.sandboxSessionKey,
      currentChannelId: attempt.currentChannelId,
      currentMessagingTarget: attempt.currentMessagingTarget,
      currentThreadId: attempt.currentThreadTs,
      currentMessageId: attempt.currentMessageId,
      replyToMode: attempt.replyToMode,
      hasRepliedRef: attempt.hasRepliedRef,
      sessionId: attempt.sessionId,
      agentId: input.hookAgentId,
      builtinToolNames: input.builtinToolNames,
      replaySafeToolNames: input.replaySafeToolNames,
      internalEvents: attempt.internalEvents,
    }),
  );
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
      input.toolSearchTargetTranscriptProjections.push({
        parentToolCallId: toolParams.parentToolCallId,
        toolCallId: toolParams.toolCallId,
        toolName: toolParams.toolName,
        input: toolParams.input,
        result: acceptedResult,
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

  const abortActiveRunExternally = (reason?: "user_abort" | "restart" | "superseded") => {
    input.markExternalAbort();
    attempt.onAttemptAbort?.();
    input.abortRun(false, reason === "restart" ? createAgentRunRestartAbortError() : undefined);
  };
  let acceptingSteerMessages = true;
  const queueHandle: AttemptStreamQueueHandle = {
    kind: "embedded",
    runId: attempt.runId,
    queueMessage: async (text: string, options) => {
      if (options?.steeringMode) {
        input.activeSession.agent.steeringMode = options.steeringMode;
      }
      await steerActiveSessionWithOptionalDeliveryWait(
        input.activeSession,
        text,
        options,
        attempt.sessionKey,
      );
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
    stopAcceptingSteerMessages: () => {
      acceptingSteerMessages = false;
    },
  };
}
