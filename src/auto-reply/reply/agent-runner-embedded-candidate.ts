import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveOpenAIRuntimeProvider } from "../../agents/openai-routing.js";
import { resolveGroupSessionKey } from "../../config/sessions.js";
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
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../types.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import {
  createAgentRunEventHandler,
  type MessageToolDeliveryState,
} from "./agent-runner-event-handler.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import { resolveReplyOperationTerminationFields } from "./reply-operation-abort.js";
import { markReplyOperationGlobalLaneWaitProgress } from "./reply-run-registry.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";
import {
  bindSourceReplyDeliveryRuntime,
  readSourceReplyDeliveryRuntime,
} from "./source-reply-delivery-runtime.js";

export async function runEmbeddedFallbackCandidate(
  params: AgentFallbackCandidateCommonParams & {
    effectiveRun: AgentFallbackCandidateCommonParams["candidateRun"];
    sessionRuntimeOverride?: string;
    getLifecycleGeneration: () => string;
    onLifecycleGeneration: (generation: string) => void;
    allowTransientCooldownProbe?: boolean;
    suppressAssistantErrorPersistenceForCandidate: boolean;
    onAssistantErrorMessagePersisted: () => void;
    notifyUserAboutCompaction: boolean;
    messageToolDeliveryState: MessageToolDeliveryState;
    githubPublicationAvailable: boolean;
    onCompactionCount: (count: number) => void;
  },
): Promise<{
  result: Awaited<ReturnType<typeof runEmbeddedAgent>>;
  bootstrapPromptWarningSignaturesSeen: string[];
}> {
  const turn = params.turn;
  const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(params.candidateRun);
  const candidateRun = {
    ...params.candidateRun,
    ...params.candidateFastMode,
    thinkLevel: params.candidateThinkLevel,
  };
  const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
    run: candidateRun,
    replyRoute: turn.followupRun,
    sessionCtx: turn.sessionCtx,
    hasRepliedRef: turn.opts?.hasRepliedRef,
    provider: params.provider,
    runId: params.runId,
    promptCacheKey: turn.opts?.promptCacheKey,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    model: params.model,
  });
  if (sourceReplyDeliveryRuntime) {
    bindSourceReplyDeliveryRuntime(runBaseParams, sourceReplyDeliveryRuntime);
  }
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
          sourceReplySessionKey: embeddedContext.sessionKey,
          sessionId: embeddedContext.sessionId,
          requesterAccountId: embeddedContext.agentAccountId,
          requesterSenderId: senderContext.senderId,
          requesterSenderName: senderContext.senderName,
          requesterSenderUsername: senderContext.senderUsername,
          requesterSenderE164: senderContext.senderE164,
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
    resolveTerminationFields: (error) =>
      resolveReplyOperationTerminationFields(error, params.runAbortSignal, turn.replyOperation),
  });
  params.onLifecycleBackstop(lifecycleBackstop);
  const toolAuthorityRoute = { provider: embeddedRunProvider, model: params.model };
  turn.replyOperation?.bindToolAuthorityRoute(toolAuthorityRoute);
  try {
    // Profiler milestone. Exposes pre-dispatch delay without normal-path logging.
    params.timing.logMilestoneIfSlow({
      runId: params.runId,
      sessionId: turn.followupRun.run.sessionId,
      sessionKey: turn.sessionKey,
      milestone: "before_embedded_run",
    });
    let eventHandler: ReturnType<typeof createAgentRunEventHandler> | undefined;
    const result = await params.timing.measure("embedded_run", () => {
      const embeddedRunParams: RunEmbeddedAgentInternalParams = {
        preparedRunAdmission: params.preparedRunAdmission,
        githubPublicationAvailable: params.githubPublicationAvailable,
        ...embeddedContext,
        messageActionTurnCapability,
        lifecycleGeneration: params.getLifecycleGeneration(),
        allowGatewaySubagentBinding: true,
        trigger: turn.isHeartbeat ? "heartbeat" : "user",
        cronCreatorAuthorityCapability: turn.opts?.cronCreatorAuthorityCapability,
        cronCreatorAuthorityUnavailableReason:
          turn.opts?.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable,
        groupId: resolveGroupSessionKey(turn.sessionCtx)?.id,
        groupChannel:
          normalizeOptionalString(turn.sessionCtx.GroupChannel) ??
          normalizeOptionalString(turn.sessionCtx.GroupSubject),
        groupSpace: normalizeOptionalString(turn.sessionCtx.GroupSpace),
        ...senderContext,
        ...runBaseParams,
        contextWindow: turn.getActiveSessionEntry()?.contextWindow,
        lane: params.runLane,
        provider: embeddedRunProvider,
        agentHarnessId: embeddedRunHarnessOverride,
        agentHarnessRuntimeOverride: embeddedRunHarnessOverride,
        agentHarnessRuntimePreparationHint:
          agentHarnessPolicy.runtimeSource !== "implicit" ? agentHarnessPolicy.runtime : undefined,
        fastModeStartedAtMs: params.fastModeStartedAtMs,
        fastModeAutoProgressState: params.fastModeAutoProgressState,
        isFinalFallbackAttempt: params.isFinalFallbackAttempt,
        sandboxSessionKey: turn.runtimePolicySessionKey,
        prompt: turn.commandBody,
        transcriptPrompt: turn.transcriptCommandBody,
        media: turn.followupRun.media,
        userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
        contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
        onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
        currentInboundEventKind: turn.followupRun.currentInboundEventKind,
        currentInboundContext: turn.followupRun.currentInboundContext,
        explicitSkillSelections: turn.followupRun.explicitSkillSelections,
        extraSystemPrompt: turn.followupRun.run.extraSystemPrompt,
        sourceReplyDeliveryMode: turn.followupRun.run.sourceReplyDeliveryMode,
        forceMessageTool: turn.followupRun.run.sourceReplyDeliveryMode === "message_tool_only",
        // Heartbeat ambient routes are delivery context, never implicit message recipients.
        // Omit false so subagent sessions keep their downstream default.
        ...(turn.isHeartbeat ? { requireExplicitMessageTarget: true } : {}),
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
        suppressToolErrorWarnings: turn.opts?.suppressToolErrorWarnings,
        toolsAllow: turn.opts?.toolsAllow,
        disableTools: turn.opts?.disableTools,
        toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(
          turn.followupRun,
          toolAuthorityRoute,
        ),
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
        onLaneWait: ({ waiting }) => {
          const replyOperation = turn.replyOperation;
          if (waiting && replyOperation) {
            markReplyOperationGlobalLaneWaitProgress(replyOperation);
          }
        },
        blockReplyBreak: turn.resolvedBlockStreamingBreak,
        blockReplyChunking: turn.blockReplyChunking,
        // Subscriber callbacks are detached. Stage channel presentation before typing I/O.
        onPartialReply: async (payload) => {
          const classified = params.presentation.classifyStreamingPartial(payload);
          if (classified.skip || !classified.text) {
            return false;
          }
          const textForTyping = classified.text;
          let didMaterialize = false;
          let materializedText: string | undefined;
          const partialPayload: PartialReplyPayload = {
            get text() {
              if (!didMaterialize) {
                const sanitized = params.presentation.sanitizeStreamingText(textForTyping, false);
                materializedText = sanitized.skip ? undefined : sanitized.text;
                didMaterialize = true;
              }
              return materializedText;
            },
            mediaUrls: payload.mediaUrls,
          };
          const onPartialReply = turn.opts?.onPartialReply;
          if (!params.preserveProgressCallbackStartOrder) {
            await turn.typingSignals.signalTextDelta(textForTyping);
            if (!onPartialReply) {
              return false;
            }
            return await onPartialReply(partialPayload);
          }
          if (!onPartialReply) {
            await turn.typingSignals.signalTextDelta(textForTyping);
            return false;
          }
          return await params.presentation.startPresentationWhileTyping(
            turn.typingSignals.signalTextDelta(textForTyping),
            () => onPartialReply(partialPayload),
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
            async () => {
              await turn.opts?.onAssistantMessageStart?.();
            },
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
                  async () => {
                    await turn.opts?.onReasoningStream?.({
                      text: payload.text,
                      mediaUrls: payload.mediaUrls,
                      isReasoningSnapshot: payload.isReasoningSnapshot,
                      requiresReasoningProgressOptIn: payload.requiresReasoningProgressOptIn,
                    });
                  },
                );
              }
            : undefined,
        streamReasoningInNonStreamModes: turn.opts?.streamReasoningInNonStreamModes,
        onReasoningEnd: turn.opts?.onReasoningEnd
          ? async () => {
              await turn.opts?.onReasoningEnd?.();
            }
          : undefined,
        onAgentEvent: (event) => {
          eventHandler ??= createAgentRunEventHandler({
            turn,
            lifecycleBackstop,
            notifyAgentRunStart: params.notifyAgentRunStart,
            sourceRepliesAreToolOnly:
              (sourceReplyDeliveryRuntime?.currentMode ??
                turn.followupRun.run.sourceReplyDeliveryMode) === "message_tool_only",
            messageToolDeliveryState: params.messageToolDeliveryState,
            provider: params.provider,
            model: params.model,
            runId: params.runId,
            effectiveSessionId: params.effectiveRun.sessionId,
            notifyUserAboutCompaction: params.notifyUserAboutCompaction,
            onCompactionCompleted: () => {
              attemptCompactionCount += 1;
              return attemptCompactionCount;
            },
          });
          return eventHandler(event);
        },
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
                const delivery = toolResultChain.then(async () => {
                  turn.replyOperation?.recordActivity();
                  const { text, skip } = params.presentation.normalizeStreamingText(payload);
                  if (skip) {
                    return;
                  }
                  if (text !== undefined) {
                    await turn.typingSignals.signalTextDelta(text);
                  }
                  await turn.opts?.onToolResult?.({ ...payload, text });
                });
                // Keep later results best-effort while exposing this delivery to awaiting owners.
                toolResultChain = delivery.catch((err: unknown) => {
                  logVerbose(`tool result delivery failed: ${String(err)}`);
                });
                const task = toolResultChain.finally(() => {
                  turn.pendingToolTasks.delete(task);
                });
                turn.pendingToolTasks.add(task);
                return delivery;
              };
            })()
          : undefined,
      };
      return runEmbeddedAgent(embeddedRunParams);
    });
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
