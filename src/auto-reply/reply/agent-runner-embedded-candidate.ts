import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import type { BootstrapContextRunKind } from "../../agents/bootstrap-mode.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveOpenAIRuntimeProvider } from "../../agents/openai-routing.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { resolveGroupSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapabilityLifetime,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { logVerbose } from "../../globals.js";
import {
  isMarkdownCapableMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import type { ThinkLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  createAgentLifecycleTerminalBackstop,
  type AgentLifecycleTerminalBackstop,
} from "./agent-lifecycle-terminal.js";
import {
  createAgentRunEventHandler,
  type MessageToolDeliveryState,
} from "./agent-runner-event-handler.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";
import { isReplyOperationRestartAbort } from "./reply-operation-abort.js";

type EmbeddedPresentation = Pick<
  ReturnType<typeof createAgentTurnPresentation>,
  | "normalizeStreamingText"
  | "preparePartialForTyping"
  | "handlePartialForTyping"
  | "startPresentationWhileTyping"
  | "blockReplyHandler"
>;

export async function runEmbeddedFallbackCandidate(params: {
  turn: AgentTurnParams;
  effectiveRun: FollowupRun["run"];
  candidateRun: FollowupRun["run"];
  runtimeConfig: OpenClawConfig;
  provider: string;
  model: string;
  sessionRuntimeOverride?: string;
  candidateThinkLevel?: ThinkLevel;
  candidateFastMode: Pick<RunEmbeddedAgentParams, "fastMode" | "fastModeAutoOnSeconds">;
  runId: string;
  getLifecycleGeneration: () => string;
  onLifecycleGeneration: (generation: string) => void;
  runAbortSignal?: AbortSignal;
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
  suppressQueuedUserPersistenceForCandidate: boolean;
  suppressAssistantErrorPersistenceForCandidate: boolean;
  onAssistantErrorMessagePersisted: () => void;
  userTurnTranscriptRecorder: NonNullable<AgentTurnParams["opts"]>["userTurnTranscriptRecorder"];
  notifyUserMessagePersisted: () => void;
  fastModeStartedAtMs: number;
  fastModeAutoProgressState: FastModeAutoProgressState;
  bootstrapContextRunKind: BootstrapContextRunKind;
  bootstrapPromptWarningSignaturesSeen: string[];
  currentTurnImages: Awaited<
    ReturnType<typeof import("./current-turn-images.js").resolveCurrentTurnImages>
  >;
  signalExecutionPhaseForTyping: NonNullable<
    Parameters<typeof runEmbeddedAgent>[0]["onExecutionPhase"]
  >;
  notifyAgentRunStart: () => void;
  notifyUserAboutCompaction: boolean;
  sourceRepliesAreToolOnly: boolean;
  messageToolDeliveryState: MessageToolDeliveryState;
  preserveProgressCallbackStartOrder: boolean;
  presentation: EmbeddedPresentation;
  timing: AgentTurnTimingTracker;
  onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => void;
  onCompactionCount: (count: number) => void;
}): Promise<{
  result: Awaited<ReturnType<typeof runEmbeddedAgent>>;
  bootstrapPromptWarningSignaturesSeen: string[];
}> {
  const turn = params.turn;
  const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
    run: {
      ...params.candidateRun,
      ...params.candidateFastMode,
      thinkLevel: params.candidateThinkLevel,
    },
    replyRoute: turn.followupRun,
    sessionCtx: turn.sessionCtx,
    hasRepliedRef: turn.opts?.hasRepliedRef,
    provider: params.provider,
    runId: params.runId,
    promptCacheKey: turn.opts?.promptCacheKey,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    model: params.model,
  });
  const agentHarnessPolicy = params.sessionRuntimeOverride
    ? ({ runtime: params.sessionRuntimeOverride, runtimeSource: "model" } as const)
    : resolveAgentHarnessPolicy({
        provider: params.provider,
        modelId: params.model,
        config: params.runtimeConfig,
        agentId: turn.followupRun.run.agentId,
        sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
      });
  const embeddedRunProvider = resolveOpenAIRuntimeProvider({
    provider: params.provider,
    harnessRuntime: agentHarnessPolicy.runtime,
    authProfileProvider: runBaseParams.authProfileId?.split(":", 1)[0],
    authProfileId: runBaseParams.authProfileId,
    config: params.runtimeConfig,
    workspaceDir: turn.followupRun.run.workspaceDir,
  });
  const embeddedRunHarnessOverride =
    params.sessionRuntimeOverride ??
    (agentHarnessPolicy.runtime === "openclaw" && embeddedRunProvider !== params.provider
      ? "openclaw"
      : undefined);
  const messageActionCapabilitySessionKey =
    turn.runtimePolicySessionKey ?? embeddedContext.sessionKey;
  const messageActionTurnCapability =
    isTrustedMessageActionTurnIngress(turn.sessionCtx.Provider) &&
    !turn.isHeartbeat &&
    embeddedContext.agentId &&
    messageActionCapabilitySessionKey &&
    embeddedContext.messageProvider &&
    embeddedContext.currentChannelId
      ? mintMessageActionTurnCapability({
          agentId: embeddedContext.agentId,
          runId: params.runId,
          sessionKey: messageActionCapabilitySessionKey,
          sessionId: embeddedContext.sessionId,
          requesterAccountId: embeddedContext.agentAccountId,
          requesterSenderId: senderContext.senderId,
          toolContext: {
            currentChannelId: embeddedContext.currentChannelId,
            currentChatType: embeddedContext.chatType,
            currentMessagingTarget: embeddedContext.currentMessagingTarget,
            currentGraphChannelId: embeddedContext.currentGraphChannelId,
            currentChannelProvider: embeddedContext.currentChannelProvider,
            currentThreadTs: embeddedContext.currentThreadTs,
            currentMessageId: embeddedContext.currentMessageId,
            currentSourceTurnId: embeddedContext.currentSourceTurnId,
            replyToMode: embeddedContext.replyToMode,
            hasRepliedRef: embeddedContext.hasRepliedRef,
            sameChannelThreadRequired: embeddedContext.sameChannelThreadRequired,
          },
          ...resolveMessageActionTurnCapabilityLifetime(runBaseParams.timeoutMs),
        })
      : undefined;
  let attemptCompactionCount = 0;
  const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey: turn.sessionKey,
    getLifecycleGeneration: params.getLifecycleGeneration,
    resolveTerminationFields: (error) => ({
      ...resolveAgentRunErrorLifecycleFields(error, params.runAbortSignal),
      ...(isReplyOperationRestartAbort(turn.replyOperation)
        ? {
            aborted: true as const,
            stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
          }
        : {}),
    }),
  });
  params.onLifecycleBackstop(lifecycleBackstop);
  try {
    // Profiler milestone. Exposes pre-dispatch delay without normal-path logging.
    params.timing.logMilestoneIfSlow({
      runId: params.runId,
      sessionId: turn.followupRun.run.sessionId,
      sessionKey: turn.sessionKey,
      milestone: "before_embedded_run",
    });
    const result = await params.timing.measure("embedded_run", () =>
      runEmbeddedAgent({
        ...embeddedContext,
        messageActionTurnCapability,
        lifecycleGeneration: params.getLifecycleGeneration(),
        allowGatewaySubagentBinding: true,
        trigger: turn.isHeartbeat ? "heartbeat" : "user",
        groupId: resolveGroupSessionKey(turn.sessionCtx)?.id,
        groupChannel:
          normalizeOptionalString(turn.sessionCtx.GroupChannel) ??
          normalizeOptionalString(turn.sessionCtx.GroupSubject),
        groupSpace: normalizeOptionalString(turn.sessionCtx.GroupSpace),
        ...senderContext,
        ...runBaseParams,
        provider: embeddedRunProvider,
        agentHarnessId: embeddedRunHarnessOverride,
        agentHarnessRuntimeOverride: embeddedRunHarnessOverride,
        fastModeStartedAtMs: params.fastModeStartedAtMs,
        fastModeAutoProgressState: params.fastModeAutoProgressState,
        isFinalFallbackAttempt: params.isFinalFallbackAttempt,
        sandboxSessionKey: turn.runtimePolicySessionKey,
        prompt: turn.commandBody,
        transcriptPrompt: turn.transcriptCommandBody,
        media: turn.followupRun.media,
        userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
        currentInboundEventKind: turn.followupRun.currentInboundEventKind,
        currentInboundContext: turn.followupRun.currentInboundContext,
        extraSystemPrompt: turn.followupRun.run.extraSystemPrompt,
        sourceReplyDeliveryMode: turn.followupRun.run.sourceReplyDeliveryMode,
        forceMessageTool: turn.followupRun.run.sourceReplyDeliveryMode === "message_tool_only",
        silentReplyPromptMode: turn.followupRun.run.silentReplyPromptMode,
        suppressNextUserMessagePersistence: params.suppressQueuedUserPersistenceForCandidate,
        onUserMessagePersisted: params.notifyUserMessagePersisted,
        suppressTranscriptOnlyAssistantPersistence:
          turn.followupRun.run.suppressTranscriptOnlyAssistantPersistence,
        suppressAssistantErrorPersistence: params.suppressAssistantErrorPersistenceForCandidate,
        onAssistantErrorMessagePersisted: params.onAssistantErrorMessagePersisted,
        toolResultFormat: (() => {
          const channel = resolveMessageChannel(turn.sessionCtx.Surface, turn.sessionCtx.Provider);
          return !channel || isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
        })(),
        toolProgressDetail: turn.toolProgressDetail,
        suppressToolErrorWarnings:
          turn.opts?.shouldSuppressToolErrorWarnings ?? turn.opts?.suppressToolErrorWarnings,
        toolsAllow: turn.opts?.toolsAllow,
        disableTools: turn.opts?.disableTools,
        enableHeartbeatTool: turn.opts?.enableHeartbeatTool,
        forceHeartbeatTool: turn.opts?.forceHeartbeatTool,
        bootstrapContextMode: turn.opts?.bootstrapContextMode,
        bootstrapContextRunKind: params.bootstrapContextRunKind,
        images: params.currentTurnImages.images,
        imageOrder: params.currentTurnImages.imageOrder,
        abortSignal: params.runAbortSignal,
        replyOperation: turn.replyOperation,
        deferTerminalLifecycle: true,
        onExecutionStarted: (info) => {
          if (info?.lifecycleGeneration) {
            params.onLifecycleGeneration(info.lifecycleGeneration);
          }
        },
        onExecutionPhase: params.signalExecutionPhaseForTyping,
        blockReplyBreak: turn.resolvedBlockStreamingBreak,
        blockReplyChunking: turn.blockReplyChunking,
        // Subscriber callbacks are detached. Stage channel presentation before typing I/O.
        onPartialReply: async (payload) => {
          if (!params.preserveProgressCallbackStartOrder) {
            const textForTyping = await params.presentation.handlePartialForTyping(payload);
            if (!turn.opts?.onPartialReply || textForTyping === undefined) {
              return;
            }
            await turn.opts.onPartialReply({ text: textForTyping, mediaUrls: payload.mediaUrls });
            return;
          }
          const textForTyping = params.presentation.preparePartialForTyping(payload);
          if (textForTyping === undefined) {
            return;
          }
          await params.presentation.startPresentationWhileTyping(
            turn.typingSignals.signalTextDelta(textForTyping),
            () =>
              turn.opts?.onPartialReply?.({ text: textForTyping, mediaUrls: payload.mediaUrls }),
          );
        },
        onAssistantMessageStart: async () => {
          if (!params.preserveProgressCallbackStartOrder) {
            await turn.typingSignals.signalMessageStart();
            await turn.opts?.onAssistantMessageStart?.();
            return;
          }
          await params.presentation.startPresentationWhileTyping(
            turn.typingSignals.signalMessageStart(),
            () => turn.opts?.onAssistantMessageStart?.(),
          );
        },
        onReasoningStream:
          turn.typingSignals.shouldStartOnReasoning || turn.opts?.onReasoningStream
            ? async (payload) => {
                if (turn.followupRun.run.silentExpected) {
                  return;
                }
                if (!params.preserveProgressCallbackStartOrder) {
                  await turn.typingSignals.signalReasoningDelta();
                  await turn.opts?.onReasoningStream?.({
                    text: payload.text,
                    mediaUrls: payload.mediaUrls,
                    isReasoningSnapshot: payload.isReasoningSnapshot,
                    requiresReasoningProgressOptIn: payload.requiresReasoningProgressOptIn,
                  });
                  return;
                }
                await params.presentation.startPresentationWhileTyping(
                  turn.typingSignals.signalReasoningDelta(),
                  () =>
                    turn.opts?.onReasoningStream?.({
                      text: payload.text,
                      mediaUrls: payload.mediaUrls,
                      isReasoningSnapshot: payload.isReasoningSnapshot,
                      requiresReasoningProgressOptIn: payload.requiresReasoningProgressOptIn,
                    }),
                );
              }
            : undefined,
        streamReasoningInNonStreamModes: turn.opts?.streamReasoningInNonStreamModes,
        onReasoningEnd: turn.opts?.onReasoningEnd,
        onAgentEvent: createAgentRunEventHandler({
          turn,
          lifecycleBackstop,
          notifyAgentRunStart: params.notifyAgentRunStart,
          sourceRepliesAreToolOnly: params.sourceRepliesAreToolOnly,
          messageToolDeliveryState: params.messageToolDeliveryState,
          provider: params.provider,
          model: params.model,
          effectiveSessionId: params.effectiveRun.sessionId,
          notifyUserAboutCompaction: params.notifyUserAboutCompaction,
          onCompactionCompleted: () => {
            attemptCompactionCount += 1;
            return attemptCompactionCount;
          },
        }),
        // Flush-before-tool requires a handler even when regular block streaming is off.
        onBlockReply: params.presentation.blockReplyHandler,
        onBlockReplyFlush:
          turn.blockStreamingEnabled && turn.blockReplyPipeline
            ? async () => {
                await turn.blockReplyPipeline?.flush({ force: true });
              }
            : undefined,
        shouldEmitToolResult: turn.shouldEmitToolResult,
        shouldEmitToolOutput: turn.shouldEmitToolOutput,
        bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
        bootstrapPromptWarningSignature:
          params.bootstrapPromptWarningSignaturesSeen[
            params.bootstrapPromptWarningSignaturesSeen.length - 1
          ],
        onToolResult: turn.opts?.onToolResult
          ? (() => {
              // Serialized delivery preserves tool result order across detached callbacks.
              let toolResultChain: Promise<void> = Promise.resolve();
              return (payload: ReplyPayload) => {
                toolResultChain = toolResultChain
                  .then(async () => {
                    turn.replyOperation?.recordActivity();
                    const { text, skip } = params.presentation.normalizeStreamingText(payload);
                    if (skip) {
                      return;
                    }
                    if (text !== undefined) {
                      await turn.typingSignals.signalTextDelta(text);
                    }
                    await turn.opts?.onToolResult?.({ ...payload, text });
                  })
                  .catch((err: unknown) => {
                    logVerbose(`tool result delivery failed: ${String(err)}`);
                  });
                const task = toolResultChain.finally(() => {
                  turn.pendingToolTasks.delete(task);
                });
                turn.pendingToolTasks.add(task);
              };
            })()
          : undefined,
      }),
    );
    const resultCompactionCount = Math.max(0, result.meta?.agentMeta?.compactionCount ?? 0);
    attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
    return {
      result,
      bootstrapPromptWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeen(
        result.meta?.systemPromptReport,
      ),
    };
  } finally {
    params.onCompactionCount(attemptCompactionCount);
    revokeMessageActionTurnCapability(messageActionTurnCapability);
  }
}
