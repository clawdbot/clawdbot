import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import type { BootstrapContextRunKind } from "../../agents/bootstrap-mode.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import {
  getCliSessionBinding,
  shouldClearFailedCliSessionBinding,
} from "../../agents/cli-session.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import type { ContextEngineLogicalTurnLease } from "../../agents/harness/context-engine-logical-turn.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { withLocalSessionPlacementTurnAdmission } from "../../agents/session-placement-admission.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import type { ThinkLevel } from "../thinking.js";
import {
  createAgentLifecycleTerminalBackstop,
  type AgentLifecycleTerminalBackstop,
} from "./agent-lifecycle-terminal.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import {
  clearCliSessionBindingForRun,
  createCliReasoningStreamBridge,
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { shouldBridgeCliPreambleEvents } from "./get-reply.types.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import { isReplyOperationRestartAbort } from "./reply-operation-abort.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

type CliPresentation = Pick<
  ReturnType<typeof createAgentTurnPresentation>,
  | "blockReplyHandler"
  | "classifyStreamingPartial"
  | "sanitizeStreamingText"
  | "startPresentationWhileTyping"
>;

export async function runCliFallbackCandidate(params: {
  preparedRunAdmission: PreparedAgentRunAdmission;
  turn: AgentTurnParams;
  candidateRun: FollowupRun["run"];
  runtimeConfig: OpenClawConfig;
  provider: string;
  model: string;
  cliExecutionProvider: string;
  candidateThinkLevel?: ThinkLevel;
  candidateFastMode: Pick<RunCliAgentParams, "fastMode" | "fastModeAutoOnSeconds">;
  runId: string;
  lifecycleGeneration: string;
  runAbortSignal?: AbortSignal;
  runLane: RunCliAgentParams["lane"];
  isFinalFallbackAttempt?: boolean;
  suppressQueuedUserPersistenceForCandidate: boolean;
  userTurnTranscriptRecorder: RunCliAgentParams["userTurnTranscriptRecorder"];
  contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease;
  onContextEngineTurnCandidate: RunCliAgentParams["onContextEngineTurnCandidate"];
  notifyUserMessagePersisted: () => void;
  fastModeStartedAtMs: number;
  fastModeAutoProgressState: FastModeAutoProgressState;
  bootstrapContextRunKind: BootstrapContextRunKind;
  bootstrapPromptWarningSignaturesSeen: string[];
  currentTurnImages: Awaited<
    ReturnType<typeof import("./current-turn-images.js").resolveCurrentTurnImages>
  >;
  signalExecutionPhaseForTyping: NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>;
  notifyAgentRunStart: () => void;
  preserveProgressCallbackStartOrder: boolean;
  presentation: CliPresentation;
  timing: AgentTurnTimingTracker;
  onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => void;
}): Promise<{
  result: Awaited<ReturnType<typeof runCliAgentWithLifecycle>>;
  bootstrapPromptWarningSignaturesSeen: string[];
}> {
  const turn = params.turn;
  const normalizedProvider = normalizeProviderId(params.provider);
  const modelHasVision = Boolean(
    turn.followupRun.run.thinkingCatalog
      ?.find(
        (entry) =>
          normalizeProviderId(entry.provider) === normalizedProvider && entry.id === params.model,
      )
      ?.input?.includes("image"),
  );
  const sessionKey = turn.sessionKey ?? turn.followupRun.run.sessionKey;
  const sessionTarget =
    sessionKey && turn.storePath
      ? {
          agentId: turn.followupRun.run.agentId,
          sessionId: turn.followupRun.run.sessionId,
          sessionKey,
          storePath: turn.storePath,
        }
      : undefined;
  const cliSessionBinding = getCliSessionBinding(
    turn.getActiveSessionEntry(),
    params.cliExecutionProvider,
  );
  const cliLifecycleStartedAt = Date.now();
  const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey: turn.sessionKey,
    startedAt: cliLifecycleStartedAt,
    getLifecycleGeneration: () => params.lifecycleGeneration,
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
  const authProfile = resolveRunAuthProfile(params.candidateRun, params.cliExecutionProvider, {
    config: params.runtimeConfig,
  });
  let droppedCliSessionReplacement = false;
  const hookMessageProvider = resolveOriginMessageProvider({
    originatingChannel: turn.followupRun.originatingChannel,
    provider: turn.sessionCtx.Provider,
  });
  const cliCurrentThreadId =
    turn.followupRun.originatingThreadId ?? turn.sessionCtx.MessageThreadId;
  const isRestartSentinelContinuation =
    turn.sessionCtx.InputProvenance?.kind === "internal_system" &&
    turn.sessionCtx.InputProvenance.sourceTool === "restart-sentinel";
  const cliCurrentMessageId = isRestartSentinelContinuation
    ? turn.sessionCtx.ReplyToId
    : (turn.sessionCtx.MessageSidFull ?? turn.sessionCtx.MessageSid);
  const commandDetailsVisible = turn.resolvedVerboseLevel === "full";
  const cliToolSummaryTracker = createCliToolSummaryTracker({
    detailMode: turn.toolProgressDetail,
    commandDetailsVisible,
    shouldEmitToolResult: turn.shouldEmitToolResult,
    shouldEmitToolOutput: turn.shouldEmitToolOutput,
    deliver: async (payload) => {
      await turn.opts?.onToolResult?.(payload);
    },
  });
  // CLI backends report a tool's outcome on the result event and never repeat it,
  // so the terminal fact has to be projected here. The embedded path gets this
  // from the shared agent-event handler; without it a failed CLI command renders
  // exactly like one that succeeded.
  const deliverCliCommandOutcome = async (
    payload: {
      name: string | undefined;
      phase: "start" | "update" | "result";
      args: Record<string, unknown> | undefined;
      toolCallId?: string;
      isError?: boolean;
      result?: unknown;
    },
    commandBearing: boolean,
  ) => {
    const onCommandOutput = turn.opts?.onCommandOutput;
    if (!onCommandOutput) {
      return;
    }
    const commandOutput = buildCommandOutputFromToolResultEvent({
      stream: "tool",
      data: { ...payload, commandBearing },
    });
    if (commandOutput) {
      await onCommandOutput(commandOutput);
    }
  };
  const bridgeCliPreambleProgress =
    Boolean(turn.opts?.onItemEvent) && shouldBridgeCliPreambleEvents(turn.opts);
  const bridgeCliDurableCommentary =
    Boolean(params.presentation.blockReplyHandler) &&
    (turn.blockStreamingEnabled || turn.opts?.commentaryPayloadsEnabled === true);
  const toolAuthorityRoute = { provider: params.provider, model: params.model };
  turn.replyOperation?.bindToolAuthorityRoute(toolAuthorityRoute);
  const result = await params.timing.measure("cli_run", () =>
    withLocalSessionPlacementTurnAdmission(
      {
        sessionId: turn.followupRun.run.sessionId,
        sessionKey: turn.sessionKey,
        agentId: turn.followupRun.run.agentId,
        runId: params.runId,
      },
      async () => {
        // Admission may wait behind another turn that starts detached media.
        // Snapshot only after this turn owns the session placement.
        const mediaTaskIdsBefore = getGeneratedMediaTaskIdsForSessionKey(turn.sessionKey);
        return await runCliAgentWithLifecycle({
          runId: params.runId,
          lifecycleGeneration: params.lifecycleGeneration,
          provider: params.cliExecutionProvider,
          startedAt: cliLifecycleStartedAt,
          emitLifecycleTerminal: false,
          onAgentRunStart: params.notifyAgentRunStart,
          suppressAssistantBridge: turn.followupRun.run.silentExpected,
          onActivity: () => turn.replyOperation?.recordActivity(),
          onErrorBeforeLifecycle:
            params.cliExecutionProvider === "claude-cli" && cliSessionBinding?.sessionId
              ? async (error) => {
                  if (
                    !shouldClearFailedCliSessionBinding({
                      error,
                      binding: cliSessionBinding,
                      hasNewGeneratedMediaTask: hasNewGeneratedMediaTaskForSessionKey(
                        turn.sessionKey,
                        mediaTaskIdsBefore,
                      ),
                    })
                  ) {
                    return;
                  }
                  await clearCliSessionBindingForRun({
                    provider: params.cliExecutionProvider,
                    expectedSessionId: cliSessionBinding.sessionId,
                    sessionKey: turn.sessionKey,
                    sessionStore: turn.activeSessionStore,
                    storePath: turn.storePath,
                    activeSessionEntry: turn.getActiveSessionEntry(),
                  });
                }
              : undefined,
          preserveProgressCallbackStartOrder: params.preserveProgressCallbackStartOrder,
          onAssistantText: async (text) => {
            const classified = params.presentation.classifyStreamingPartial({ text });
            if (classified.skip || !classified.text) {
              return;
            }
            const textForTyping = classified.text;
            const sanitized = params.presentation.sanitizeStreamingText(textForTyping, false);
            const onPartialReply = turn.opts?.onPartialReply;
            if (!params.preserveProgressCallbackStartOrder) {
              await turn.typingSignals.signalTextDelta(textForTyping);
              if (sanitized.skip || !sanitized.text || !onPartialReply) {
                return false;
              }
              return await onPartialReply({ text: sanitized.text });
            }
            if (sanitized.skip || !sanitized.text) {
              await turn.typingSignals.signalTextDelta(textForTyping);
              return false;
            }
            if (!onPartialReply) {
              await turn.typingSignals.signalTextDelta(textForTyping);
              return false;
            }
            // Assistant and tool CLI bridges drain independently. Stage presentation first.
            return await params.presentation.startPresentationWhileTyping(
              turn.typingSignals.signalTextDelta(textForTyping),
              () => onPartialReply({ text: sanitized.text }),
            );
          },
          onReasoningText: createCliReasoningStreamBridge(turn.opts?.onReasoningStream),
          onPlanUpdate: turn.opts?.onPlanUpdate,
          onReasoningProgress: async (payload) => {
            await turn.opts?.onReasoningProgress?.(payload);
          },
          onToolEvent: async (payload) => {
            if (!params.preserveProgressCallbackStartOrder) {
              const commandBearing = await cliToolSummaryTracker.noteToolEvent(payload);
              if (payload.phase === "result") {
                await deliverCliCommandOutcome(payload, commandBearing);
                return;
              }
              const { name, phase, args, toolCallId } = payload;
              await Promise.all([
                turn.typingSignals.signalToolStart(),
                turn.opts?.onToolStart?.({
                  ...(toolCallId ? { toolCallId } : {}),
                  name,
                  phase,
                  args,
                  detailMode: turn.toolProgressDetail,
                }),
              ]);
              return;
            }
            const summaryPromise = cliToolSummaryTracker.noteToolEvent(payload);
            if (payload.phase === "result") {
              const commandBearing = await summaryPromise;
              await deliverCliCommandOutcome(payload, commandBearing);
              return;
            }
            const { name, phase, args, toolCallId } = payload;
            // Tool and assistant bridges drain independently. Preserve source order.
            await Promise.all([
              summaryPromise,
              params.presentation.startPresentationWhileTyping(
                turn.typingSignals.signalToolStart(),
                async () => {
                  await turn.opts?.onToolStart?.({
                    ...(toolCallId ? { toolCallId } : {}),
                    name,
                    phase,
                    args,
                    detailMode: turn.toolProgressDetail,
                  });
                },
              ),
            ]);
          },
          onCommentaryText:
            bridgeCliPreambleProgress || bridgeCliDurableCommentary
              ? async (payload) => {
                  const deliveries: unknown[] = [];
                  if (bridgeCliPreambleProgress) {
                    deliveries.push(
                      turn.opts?.onItemEvent?.({
                        itemId: payload.itemId,
                        kind: "preamble",
                        progressText: payload.text,
                        // The block bridge owns durability; this event remains a progress preview.
                        ...(bridgeCliDurableCommentary ? { suppressDurableProgress: true } : {}),
                      }),
                    );
                  }
                  if (bridgeCliDurableCommentary) {
                    // Block mode treats completed CLI text as an ordinary answer block so
                    // the existing pipeline owns coalescing and final-payload dedupe.
                    deliveries.push(
                      params.presentation.blockReplyHandler?.({
                        text: payload.text,
                        ...(turn.blockStreamingEnabled ? {} : { isCommentary: true }),
                      }),
                    );
                  }
                  await Promise.all(deliveries);
                }
              : undefined,
          onFastModeAutoProgress: async (payload) => {
            await turn.opts?.onToolResult?.(payload);
          },
          transformResult:
            turn.followupRun.currentInboundEventKind === "room_event"
              ? (resultLocal) =>
                  keepCliSessionBindingOnlyWhenReused({
                    result: resultLocal,
                    existingSessionId: cliSessionBinding?.sessionId,
                    onDroppedReplacement: () => {
                      droppedCliSessionReplacement = true;
                    },
                  })
              : undefined,
          runParams: {
            preparedRunAdmission: params.preparedRunAdmission,
            sessionId: turn.followupRun.run.sessionId,
            sessionKey: turn.sessionKey,
            sessionTarget,
            chatType:
              normalizeChatType(turn.followupRun.originatingChatType) ??
              normalizeChatType(turn.sessionCtx.ChatType) ??
              params.candidateRun.chatType,
            runtimePolicySessionKey:
              turn.followupRun.run.runtimePolicySessionKey ?? turn.runtimePolicySessionKey,
            agentId: turn.followupRun.run.agentId,
            trigger: turn.isHeartbeat ? "heartbeat" : "user",
            sessionFile: turn.followupRun.run.sessionFile,
            workspaceDir: turn.followupRun.run.workspaceDir,
            cwd: turn.followupRun.run.cwd,
            config: params.runtimeConfig,
            toolOverrides: turn.followupRun.run.toolOverrides,
            prompt: turn.commandBody,
            transcriptPrompt: turn.transcriptCommandBody,
            media: turn.followupRun.media,
            suppressNextUserMessagePersistence: params.suppressQueuedUserPersistenceForCandidate,
            userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
            contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
            onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
            onUserMessagePersisted: params.notifyUserMessagePersisted,
            persistAssistantTranscript:
              turn.followupRun.currentInboundEventKind !== "room_event" &&
              turn.followupRun.run.suppressTranscriptOnlyAssistantPersistence !== true,
            storePath: turn.storePath,
            currentInboundEventKind: turn.followupRun.currentInboundEventKind,
            currentInboundContext: turn.followupRun.currentInboundContext,
            inputProvenance: turn.followupRun.run.inputProvenance,
            modelProvider: params.provider,
            modelHasVision,
            provider: params.cliExecutionProvider,
            execOverrides: turn.followupRun.run.execOverrides,
            bashElevated: turn.followupRun.run.bashElevated,
            model: params.model,
            thinkLevel: params.candidateThinkLevel,
            fastMode: params.candidateFastMode.fastMode,
            fastModeStartedAtMs: params.fastModeStartedAtMs,
            fastModeAutoOnSeconds: params.candidateFastMode.fastModeAutoOnSeconds,
            fastModeAutoProgressState: params.fastModeAutoProgressState,
            isFinalFallbackAttempt: params.isFinalFallbackAttempt,
            timeoutMs: turn.followupRun.run.timeoutMs,
            runTimeoutOverrideMs: turn.followupRun.run.runTimeoutOverrideMs,
            runId: params.runId,
            lane: params.runLane,
            extraSystemPrompt: turn.followupRun.run.extraSystemPrompt,
            sourceReplyDeliveryMode: turn.followupRun.run.sourceReplyDeliveryMode,
            taskSuggestionDeliveryMode: turn.followupRun.run.taskSuggestionDeliveryMode,
            // Heartbeat ambient routes are never implicit message recipients.
            ...(turn.isHeartbeat ? { requireExplicitMessageTarget: true } : {}),
            silentReplyPromptMode: turn.followupRun.run.silentReplyPromptMode,
            allowEmptyAssistantReplyAsSilent: turn.followupRun.run.allowEmptyAssistantReplyAsSilent,
            extraSystemPromptStatic: turn.followupRun.run.extraSystemPromptStatic,
            cliSessionBindingFacts: turn.followupRun.run.cliSessionBindingFacts,
            ownerNumbers: turn.followupRun.run.ownerNumbers,
            cliSessionId: cliSessionBinding?.sessionId,
            cliSessionBinding,
            authProfileId: authProfile.authProfileId,
            bootstrapContextMode: turn.opts?.bootstrapContextMode,
            bootstrapContextRunKind: params.bootstrapContextRunKind,
            bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature:
              params.bootstrapPromptWarningSignaturesSeen[
                params.bootstrapPromptWarningSignaturesSeen.length - 1
              ],
            images: params.currentTurnImages.images,
            imageOrder: params.currentTurnImages.imageOrder,
            mediaImageLayout: params.currentTurnImages.mediaImageLayout,
            skillsSnapshot: turn.followupRun.run.skillsSnapshot,
            messageChannel: turn.followupRun.originatingChannel ?? undefined,
            messageProvider: hookMessageProvider,
            clientCaps: turn.followupRun.run.clientCaps,
            currentChannelId:
              turn.followupRun.originatingTo ?? turn.sessionCtx.OriginatingTo ?? turn.sessionCtx.To,
            senderId: turn.followupRun.run.senderId,
            senderName: turn.followupRun.run.senderName,
            senderUsername: turn.followupRun.run.senderUsername,
            senderE164: turn.followupRun.run.senderE164,
            groupId: turn.followupRun.run.groupId,
            groupChannel: turn.followupRun.run.groupChannel,
            groupSpace: turn.followupRun.run.groupSpace,
            spawnedBy: turn.followupRun.run.spawnedBy,
            chatId: turn.followupRun.originatingChatId,
            channelContext: turn.followupRun.run.channelContext,
            currentThreadTs: cliCurrentThreadId != null ? String(cliCurrentThreadId) : undefined,
            currentMessageId: cliCurrentMessageId,
            replyToMode: turn.followupRun.originatingReplyToMode ?? turn.sessionCtx.ReplyToMode,
            currentInboundAudio: hasInboundAudio(turn.sessionCtx),
            agentAccountId: turn.followupRun.run.agentAccountId,
            senderIsOwner: turn.followupRun.run.senderIsOwner,
            approvalReviewerDeviceId: turn.followupRun.run.approvalReviewerDeviceId,
            toolsAllow: turn.opts?.toolsAllow,
            disableTools: turn.opts?.disableTools,
            toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(
              turn.followupRun,
              toolAuthorityRoute,
            ),
            abortSignal: params.runAbortSignal,
            onExecutionPhase: params.signalExecutionPhaseForTyping,
            replyOperation: turn.replyOperation,
          },
        });
      },
    ),
  );
  if (droppedCliSessionReplacement) {
    await clearCliSessionBindingForRun({
      provider: params.cliExecutionProvider,
      expectedSessionId: cliSessionBinding?.sessionId,
      sessionKey: turn.sessionKey,
      sessionStore: turn.activeSessionStore,
      storePath: turn.storePath,
      activeSessionEntry: turn.getActiveSessionEntry(),
    });
  }
  return {
    result,
    bootstrapPromptWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeen(
      result.meta?.systemPromptReport,
    ),
  };
}
