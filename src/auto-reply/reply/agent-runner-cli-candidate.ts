import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { buildCliMcpDelegationCapabilityBinding } from "../../agents/cli-runner/mcp-grant-context.js";
import {
  clearCliSessionInStore,
  persistCliSessionBindingResult,
  settleCliSessionResult,
} from "../../agents/cli-session-store.js";
import {
  getCliSessionBinding,
  shouldClearFailedCliSessionBinding,
} from "../../agents/cli-session.js";
import { resolveDelegationCapability } from "../../agents/delegation-capability.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import type { ModelFallbackResultClassification } from "../../agents/model-fallback-attempt.js";
import { createAgentRunSupersededAbortError } from "../../agents/run-termination.js";
import { withLocalSessionPlacementTurnSettlement } from "../../agents/session-placement-admission.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import {
  createCliReasoningStreamBridge,
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import { resolveRunModelHasVision } from "./agent-runner-run-params.js";
import { shouldBridgeCliPreambleEvents } from "./get-reply.types.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveReplyOperationTerminationFields } from "./reply-operation-abort.js";

export async function runCliFallbackCandidate(
  params: AgentFallbackCandidateCommonParams & {
    cliExecutionProvider: string;
    classifyResult: (result: EmbeddedAgentRunResult) => ModelFallbackResultClassification;
    lifecycleGeneration: string;
  },
): Promise<{
  result: Awaited<ReturnType<typeof runCliAgentWithLifecycle>>;
  bootstrapPromptWarningSignaturesSeen: string[];
}> {
  const turn = params.turn;
  const expectedLifecycleRevision = turn.getActiveSessionEntry()?.lifecycleRevision;
  const selectedModelEntry = findModelInCatalog(
    params.candidateRun.thinkingCatalog ?? [],
    params.provider,
    params.model,
  );
  const modelHasVision = await resolveRunModelHasVision({
    run: params.candidateRun,
    provider: params.provider,
    model: params.model,
  });
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
  const cliLifecycleStartedAt = Date.now();
  const lifecycleBackstop = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey: turn.sessionKey,
    startedAt: cliLifecycleStartedAt,
    getLifecycleGeneration: () => params.lifecycleGeneration,
    resolveTerminationFields: (error) =>
      resolveReplyOperationTerminationFields(error, params.runAbortSignal, turn.replyOperation),
  });
  params.onLifecycleBackstop(lifecycleBackstop);
  const authProfile = resolveRunAuthProfile(params.candidateRun, params.cliExecutionProvider, {
    config: params.runtimeConfig,
  });
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
  const toolAuthorityFingerprint = turn.replyOperation?.bindToolAuthorityRoute(toolAuthorityRoute);
  const result = await params.timing.measure("cli_run", () =>
    withLocalSessionPlacementTurnSettlement(
      {
        sessionId: turn.followupRun.run.sessionId,
        sessionKey,
        agentId: turn.followupRun.run.agentId,
        runId: params.runId,
      },
      async (assertSettlementCurrent) => {
        // Placement admission may wait behind an older turn. Snapshot placement,
        // permission, and native resume identity only after this turn owns it.
        const sessionEntry = sessionTarget
          ? loadSessionEntry({ ...sessionTarget, readConsistency: "latest" })
          : turn.getActiveSessionEntry();
        if (
          sessionTarget &&
          (sessionEntry?.sessionId !== sessionTarget.sessionId ||
            sessionEntry.lifecycleRevision !== expectedLifecycleRevision)
        ) {
          throw createAgentRunSupersededAbortError();
        }
        const diagnosticOwner = params.deferredLifecycle.handoffToCli();
        const cliSessionBinding = getCliSessionBinding(sessionEntry, params.cliExecutionProvider);
        const mediaTaskIdsBefore = getGeneratedMediaTaskIdsForSessionKey(turn.sessionKey);
        let droppedCliSessionReplacement = false;
        const candidateResult = await runCliAgentWithLifecycle({
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
                  await clearCliSessionInStore({
                    provider: params.cliExecutionProvider,
                    expectedCliSessionId: cliSessionBinding.sessionId,
                    expectedSessionId: sessionEntry?.sessionId,
                    assertCommitAllowed: assertSettlementCurrent,
                    sessionKey: turn.sessionKey,
                    sessionStore: turn.activeSessionStore,
                    storePath: turn.storePath,
                    activeSessionEntry: sessionEntry,
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
            return await params.presentation.presentWithTyping(
              turn.typingSignals.signalTextDelta(textForTyping),
              () =>
                sanitized.skip || !sanitized.text || !onPartialReply
                  ? false
                  : onPartialReply({ text: sanitized.text }),
            );
          },
          onReasoningText: createCliReasoningStreamBridge(turn.opts?.onReasoningStream),
          onPlanUpdate: turn.opts?.onPlanUpdate,
          onReasoningProgress: async (payload) => {
            await turn.opts?.onReasoningProgress?.(payload);
          },
          onCompactionStart: turn.opts?.onCompactionStart,
          onCompactionEnd: turn.opts?.onCompactionEnd,
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
              params.presentation.presentWithTyping(
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
            diagnosticOwner,
            sessionId: turn.followupRun.run.sessionId,
            sessionKey,
            sessionTarget,
            sessionEntry,
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
            prepareAssistantTranscriptMessage: turn.opts?.prepareAssistantTranscriptMessage,
            persistAssistantTranscript:
              turn.followupRun.currentInboundEventKind !== "room_event" &&
              turn.followupRun.run.suppressTranscriptOnlyAssistantPersistence !== true,
            storePath: turn.storePath,
            currentInboundEventKind: turn.followupRun.currentInboundEventKind,
            currentInboundContext: turn.followupRun.currentInboundContext,
            inputProvenance: turn.followupRun.run.inputProvenance,
            // Candidate zero is the primary attempt; later candidates are
            // fallbacks. Carry the runner-owned fact instead of inferring from
            // this shared dispatch path, or primary CLI runs lose delegation.
            ...buildCliMcpDelegationCapabilityBinding(
              resolveDelegationCapability({
                fallbackActive: params.isFallbackRetry,
                inputProvenance: turn.followupRun.run.inputProvenance,
                disableTools: turn.opts?.disableTools,
                toolsAllow: turn.opts?.toolsAllow,
              }),
            ),
            modelProvider: params.provider,
            modelHasVision,
            modelContextWindow: selectedModelEntry?.contextWindow,
            modelContextTokens: selectedModelEntry?.contextTokens,
            contextWindow: sessionEntry?.contextWindow,
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
            skillWorkshopProposalRevision: params.candidateRun.skillWorkshopProposalRevision,
            skillLibraryAuthoring: params.candidateRun.skillLibraryAuthoring,
            disableTools: turn.opts?.disableTools,
            toolAuthorityFingerprint,
            abortSignal: params.runAbortSignal,
            // Native input is already host-authored. Keep its stable delivery
            // context out of the model-output normalization wrapper.
            onBlockReply: turn.opts?.onBlockReply,
            onPartialReply: turn.opts?.onPartialReply,
            onExecutionPhase: params.signalExecutionPhaseForTyping,
            replyOperation: turn.replyOperation,
          },
        });
        if (droppedCliSessionReplacement) {
          // The room-event transform removed native continuity; only its guarded
          // invalidation remains, and failure must retain the returned turn.
          return await settleCliSessionResult(candidateResult, async () => {
            await clearCliSessionInStore({
              provider: params.cliExecutionProvider,
              expectedCliSessionId: cliSessionBinding?.sessionId,
              expectedSessionId: sessionEntry?.sessionId,
              assertCommitAllowed: assertSettlementCurrent,
              sessionKey: turn.sessionKey,
              sessionStore: turn.activeSessionStore,
              storePath: turn.storePath,
              activeSessionEntry: sessionEntry,
            });
            params.classifyResult(candidateResult);
          });
        }
        const classification = params.classifyResult(candidateResult);
        if (
          (!classification || candidateResult.meta.agentMeta?.clearCliSessionBinding === true) &&
          !shouldPreserveUserFacingSessionStateForInputProvenance(
            turn.followupRun.run.inputProvenance,
          )
        ) {
          return await persistCliSessionBindingResult({
            provider: params.cliExecutionProvider,
            result: candidateResult,
            sessionKey,
            storePath: turn.storePath,
            sessionStore: turn.activeSessionStore,
            expectedSession: sessionEntry,
            assertSettlementCurrent,
            abortSignal: params.runAbortSignal,
          });
        }
        return candidateResult;
      },
      {
        lifecycleGeneration: params.lifecycleGeneration,
        abortSignal: params.runAbortSignal,
        trigger: turn.isHeartbeat ? "heartbeat" : "user",
        inputProvenance: turn.followupRun.run.inputProvenance,
      },
    ),
  );
  return {
    result,
    bootstrapPromptWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeen(
      result.meta?.systemPromptReport,
    ),
  };
}
