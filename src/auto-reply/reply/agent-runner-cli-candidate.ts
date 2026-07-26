import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import type { BootstrapContextRunKind } from "../../agents/bootstrap-mode.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { withLocalSessionPlacementTurnAdmission } from "../../agents/session-placement-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ThinkLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  createAgentLifecycleTerminalBackstop,
  type AgentLifecycleTerminalBackstop,
} from "./agent-lifecycle-terminal.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import {
  clearDroppedCliSessionBinding,
  createCliReasoningStreamBridge,
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { shouldBridgeCliPreambleEvents } from "./get-reply.types.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import { isReplyOperationRestartAbort } from "./reply-operation-abort.js";

type CliPresentation = Pick<
  ReturnType<typeof createAgentTurnPresentation>,
  "handlePartialForTyping" | "preparePartialForTyping" | "startPresentationWhileTyping"
>;

export async function runCliFallbackCandidate(params: {
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
  const cliToolSummaryTracker = createCliToolSummaryTracker({
    detailMode: turn.toolProgressDetail,
    shouldEmitToolResult: turn.shouldEmitToolResult,
    shouldEmitToolOutput: turn.shouldEmitToolOutput,
    deliver: async (payload) => {
      await turn.opts?.onToolResult?.(payload);
    },
  });
  const result = await params.timing.measure("cli_run", () =>
    withLocalSessionPlacementTurnAdmission(
      {
        sessionId: turn.followupRun.run.sessionId,
        sessionKey: turn.sessionKey,
        agentId: turn.followupRun.run.agentId,
        runId: params.runId,
      },
      () =>
        runCliAgentWithLifecycle({
          runId: params.runId,
          lifecycleGeneration: params.lifecycleGeneration,
          provider: params.cliExecutionProvider,
          startedAt: cliLifecycleStartedAt,
          emitLifecycleTerminal: false,
          onAgentRunStart: params.notifyAgentRunStart,
          suppressAssistantBridge: turn.followupRun.run.silentExpected,
          onActivity: () => turn.replyOperation?.recordActivity(),
          preserveProgressCallbackStartOrder: params.preserveProgressCallbackStartOrder,
          onAssistantText: async (text) => {
            if (!params.preserveProgressCallbackStartOrder) {
              const textForTyping = await params.presentation.handlePartialForTyping({
                text,
              } as ReplyPayload);
              if (textForTyping === undefined || !turn.opts?.onPartialReply) {
                return;
              }
              await turn.opts.onPartialReply({ text: textForTyping });
              return;
            }
            const textForTyping = params.presentation.preparePartialForTyping({
              text,
            } as ReplyPayload);
            if (textForTyping === undefined) {
              return;
            }
            // Assistant and tool CLI bridges drain independently. Stage presentation first.
            await params.presentation.startPresentationWhileTyping(
              turn.typingSignals.signalTextDelta(textForTyping),
              () => turn.opts?.onPartialReply?.({ text: textForTyping }),
            );
          },
          onReasoningText: createCliReasoningStreamBridge(turn.opts?.onReasoningStream),
          onPlanUpdate: turn.opts?.onPlanUpdate,
          onReasoningProgress: async (payload) => {
            await turn.opts?.onReasoningProgress?.(payload);
          },
          onToolEvent: async (payload) => {
            if (!params.preserveProgressCallbackStartOrder) {
              await cliToolSummaryTracker.noteToolEvent(payload);
              if (payload.phase === "result") {
                return;
              }
              const { name, phase, args } = payload;
              await Promise.all([
                turn.typingSignals.signalToolStart(),
                turn.opts?.onToolStart?.({
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
              await summaryPromise;
              return;
            }
            const { name, phase, args } = payload;
            // Tool and assistant bridges drain independently. Preserve source order.
            await Promise.all([
              summaryPromise,
              params.presentation.startPresentationWhileTyping(
                turn.typingSignals.signalToolStart(),
                () =>
                  turn.opts?.onToolStart?.({
                    name,
                    phase,
                    args,
                    detailMode: turn.toolProgressDetail,
                  }),
              ),
            ]);
          },
          onCommentaryText:
            turn.opts?.onItemEvent && shouldBridgeCliPreambleEvents(turn.opts)
              ? async (payload) => {
                  await turn.opts?.onItemEvent?.({
                    itemId: payload.itemId,
                    kind: "preamble",
                    progressText: payload.text,
                  });
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
            sessionId: turn.followupRun.run.sessionId,
            sessionKey: turn.sessionKey,
            runtimePolicySessionKey:
              turn.followupRun.run.runtimePolicySessionKey ?? turn.runtimePolicySessionKey,
            agentId: turn.followupRun.run.agentId,
            trigger: turn.isHeartbeat ? "heartbeat" : "user",
            sessionFile: turn.followupRun.run.sessionFile,
            workspaceDir: turn.followupRun.run.workspaceDir,
            cwd: turn.followupRun.run.cwd,
            config: params.runtimeConfig,
            prompt: turn.commandBody,
            transcriptPrompt: turn.transcriptCommandBody,
            media: turn.followupRun.media,
            suppressNextUserMessagePersistence: params.suppressQueuedUserPersistenceForCandidate,
            userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
            onUserMessagePersisted: params.notifyUserMessagePersisted,
            persistAssistantTranscript:
              turn.followupRun.currentInboundEventKind !== "room_event" &&
              turn.followupRun.run.suppressTranscriptOnlyAssistantPersistence !== true,
            storePath: turn.storePath,
            currentInboundEventKind: turn.followupRun.currentInboundEventKind,
            currentInboundContext: turn.followupRun.currentInboundContext,
            inputProvenance: turn.followupRun.run.inputProvenance,
            modelProvider: params.provider,
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
            currentInboundAudio: hasInboundAudio(turn.sessionCtx),
            agentAccountId: turn.followupRun.run.agentAccountId,
            senderIsOwner: turn.followupRun.run.senderIsOwner,
            approvalReviewerDeviceId: turn.followupRun.run.approvalReviewerDeviceId,
            toolsAllow: turn.opts?.toolsAllow,
            disableTools: turn.opts?.disableTools,
            abortSignal: params.runAbortSignal,
            onExecutionPhase: params.signalExecutionPhaseForTyping,
            replyOperation: turn.replyOperation,
          },
        }),
    ),
  );
  if (droppedCliSessionReplacement) {
    await clearDroppedCliSessionBinding({
      provider: params.cliExecutionProvider,
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
