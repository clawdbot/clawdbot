// Detached chat.send dispatch owns runtime delivery, post-dispatch persistence, and terminalization.
import { performance } from "node:perf_hooks";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { classifyAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { dispatchInboundMessageWithProjectedDispatcher } from "../../auto-reply/dispatch.js";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import { isReplyPayloadStatusNotice } from "../../auto-reply/reply-payload.js";
import type { ReplyMessageInjectionAttempt } from "../../auto-reply/reply/reply-run-registry.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { updateChatRunProvider } from "../chat-abort.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { RestartSafeChatTerminalState } from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { prepareChatSendAttachments } from "./chat-send-attachments.js";
import {
  resolveWebchatPromptCacheKey,
  scheduleChatDashboardSessionTitle,
} from "./chat-send-background.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import { finalizeAcceptedChatSendMessageInjection } from "./chat-send-message-injection.js";
import {
  applyChatSendReplyContextFields,
  type ChatSendReplyContextFields,
} from "./chat-send-reply-context.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import { finalizeChatSendDispatchedReplies } from "./chat-send-reply-finalization.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import {
  classifyAcceptedChatSendFailure,
  runAcceptedChatSendDispatch,
  waitForAcceptedChatSendRetry,
} from "./chat-send-retry.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";
import { applyChatSendManagedMedia, type prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  emitOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
  type ChatSendServerTimingPhase,
} from "./chat-server-timing.js";
import type { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { prepareSessionWorkspace } from "./session-create-project.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type PreparedChatSendAttachments = Extract<
  Awaited<ReturnType<typeof prepareChatSendAttachments>>,
  { ok: true }
>["value"];

type StartChatDispatchParams = {
  admissionStartedAt: number;
  admission: AdmittedChatSend;
  attachments: PreparedChatSendAttachments;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  toolsAllow?: string[];
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
  skillLibraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
  cronCreatorAuthority: ReturnType<ChatSendExternalAuthorityAdmission["resolve"]>;
  externalAuthorityAdmission: ChatSendExternalAuthorityAdmission | undefined;
  injection: {
    beginCapturedMessageInjection: () => ReplyMessageInjectionAttempt | undefined;
    messageInjectionAttempt: ReplyMessageInjectionAttempt | undefined;
    preAckReplyContextPromise: Promise<ChatSendReplyContextFields> | undefined;
    replyContextFieldsPromise: Promise<ChatSendReplyContextFields> | undefined;
  };
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  terminalizeRestartSafeAdmission: (
    terminalState: RestartSafeChatTerminalState,
  ) => Promise<boolean>;
  timing: {
    chatSendAckedAtMs: number;
    chatSendTiming: ChatRunTiming | undefined;
  };
  turn: ReturnType<typeof prepareChatSendUserTurn>;
  userTurn: ReturnType<typeof createGatewayChatUserTurnController>;
};

function formatReturnedAgentErrors(messages: string[]): string | undefined {
  const [primary, ...additional] = [...new Set(messages)];
  if (!primary || additional.length === 0) {
    return primary;
  }
  if (additional.length === 1) {
    return `${primary}\n\nAdditional error: ${additional[0]}`;
  }
  return `${primary}\n\nAdditional errors:\n${additional.map((message) => `- ${message}`).join("\n")}`;
}

export function startChatDispatch(params: StartChatDispatchParams): void {
  const {
    admissionStartedAt,
    admission,
    attachments,
    client,
    context,
    toolsAllow,
    skillWorkshopProposalRevision,
    skillLibraryAuthoring,
    cronCreatorAuthority,
    externalAuthorityAdmission,
    injection,
    request,
    session,
    terminalizeRestartSafeAdmission,
    timing,
    turn,
    userTurn,
  } = params;
  const { imageOrder } = attachments;
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    gatewayWorkAdmission,
    messageInjectionTarget,
    retainGatewayWorkAdmission,
    restartSafeAdmission,
  } = admission;
  const {
    activeRunScopeKey,
    agentId,
    cfg,
    clientRunId,
    entry,
    expectedLeafEntryId,
    requestedSessionId,
    resolvedSessionModel,
    storePath,
    selectedAgent,
    sessionKey,
  } = session;
  const { chatSendReceivedAtMs, clientInfo, p, reconnectResumeRequested, supportsTaskSuggestions } =
    request;
  const {
    accountId,
    ctx,
    isInternalTextSlashCommandTurn,
    pluginBoundMediaPromise,
    queuedFollowupOwnerKey,
    replyOptionImages,
    replyOptionMedia,
  } = turn;
  const {
    persist: persistGatewayUserTurnTranscript,
    persistBestEffort: persistGatewayUserTurnTranscriptBestEffort,
    recorder: userTurnRecorder,
  } = userTurn;
  const { beginCapturedMessageInjection, preAckReplyContextPromise, replyContextFieldsPromise } =
    injection;
  let { messageInjectionAttempt } = injection;
  const { chatSendAckedAtMs, chatSendTiming } = timing;

  let agentRunStarted = false;
  let replyDispatchRun: ReplyDispatchRun | undefined;
  const replyDispatch = createChatSendReplyDispatch({
    accountId,
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
    isAgentRunStarted: () => agentRunStarted,
    isRunCurrent: () =>
      !activeRunAbort.controller.signal.aborted &&
      context.chatAbortControllers.get(clientRunId) === activeRunAbort.entry,
    getReplyDispatchRun: () => replyDispatchRun,
    logGateway: context.logGateway,
    session,
    userTurnRecorder,
  });
  const queuedFollowup = createChatSendTurnAdoptionLifecycle({
    accountId,
    chatQueuedTurns: context.chatQueuedTurns,
    context,
    runId: clientRunId,
    controller: activeRunAbort.controller,
    sessionBinding: admission.sessionBinding,
    sessionKey,
    agentId: selectedAgent.agentId,
    ownerConnId: client?.connId,
    ownerDeviceId: client?.connect?.device?.id,
    ownerKey: queuedFollowupOwnerKey,
    ...(expectedLeafEntryId !== undefined ? { originatingLeafEntryId: expectedLeafEntryId } : {}),
    originatingChannel: admission.originatingRoute.originatingChannel,
    session,
    hasCronCreatorAuthority: cronCreatorAuthority !== undefined,
    retainWorkAdmission: retainGatewayWorkAdmission,
  });
  let acceptedMessageInjection = false;
  const classifyDispatchFailure = (error: unknown) =>
    classifyAcceptedChatSendFailure({
      error,
      phase: "post-ack",
      executionStarted: agentRunStarted,
      sideEffectsObserved:
        acceptedMessageInjection ||
        messageInjectionAttempt !== undefined ||
        replyDispatch.deliveredReplies.length > 0,
    });
  const dispatchErrorLifecycle = createChatSendDispatchErrorLifecycle({
    admission,
    classifyFailure: classifyDispatchFailure,
    context,
    isQueuedFollowupEnqueued: queuedFollowup.isEnqueued,
    persistUserTurnTranscript: persistGatewayUserTurnTranscript,
    session,
    terminalizeRestartSafeAdmission,
    userTurnRecorder,
    isReplyDispatchRun: () => replyDispatchRun !== undefined,
  });
  const emitServerTiming = (
    phase: ChatSendServerTimingPhase,
    extra?: Record<string, string | number>,
    dispatchStartedAtMs?: number,
  ) => {
    emitOperatorChatSendServerTiming({
      context,
      client,
      phase,
      runId: clientRunId,
      sessionKey,
      agentId,
      receivedAtMs: chatSendReceivedAtMs,
      ackedAtMs: chatSendAckedAtMs,
      dispatchStartedAtMs,
      extra,
    });
  };
  const dispatchStartedAtMs = performance.now();
  if (chatSendTiming) {
    chatSendTiming.dispatchStartedAtMs = dispatchStartedAtMs;
  }
  emitServerTiming("dispatch-started");
  let firstAssistantServerTimingEmitted = false;
  const emitFirstAssistantServerTiming = () => {
    if (firstAssistantServerTimingEmitted || chatSendTiming?.firstAssistantEventSent) {
      return;
    }
    firstAssistantServerTimingEmitted = true;
    if (chatSendTiming) {
      chatSendTiming.firstAssistantEventSent = true;
    }
    emitServerTiming("first-assistant-event", undefined, dispatchStartedAtMs);
  };
  const dispatchAdmission = {
    run: <T>(operation: () => Promise<T>) =>
      gatewayWorkAdmission.run(() =>
        userTurnRecorder.withPendingInput
          ? userTurnRecorder.withPendingInput(operation)
          : operation(),
      ),
  };
  const dispatch = replyDispatch
    .runAgentMediaTranscript(dispatchAdmission, () =>
      measureDiagnosticsTimelineSpan(
        "gateway.chat_send.dispatch_inbound",
        async () => {
          // Preparation stays after the ACK but inside admitted dispatch, so the
          // same visible run owns workspace progress, cancellation, and errors.
          let assertWorkspaceRunOwnership: (() => void) | undefined;
          if (entry && (Object.hasOwn(entry, "pendingProjectGitUrl") || entry.pendingWorktree)) {
            assertWorkspaceRunOwnership = await prepareSessionWorkspace({
              admission,
              client,
              context,
              session,
            });
            assertWorkspaceRunOwnership();
          }
          if (replyContextFieldsPromise && !preAckReplyContextPromise) {
            const replyContextFields = await replyContextFieldsPromise;
            assertWorkspaceRunOwnership?.();
            applyChatSendReplyContextFields(ctx, replyContextFields);
            messageInjectionAttempt = beginCapturedMessageInjection();
          }
          if (messageInjectionAttempt) {
            const injected = await finalizeAcceptedChatSendMessageInjection({
              attempt: messageInjectionAttempt,
              context,
              ctx,
              persistUserTurnTranscriptBestEffort: persistGatewayUserTurnTranscriptBestEffort,
              session,
              startedAt: admissionStartedAt,
              target: messageInjectionTarget!,
            });
            assertWorkspaceRunOwnership?.();
            if (injected) {
              acceptedMessageInjection = true;
              return {
                queuedFinal: false,
                counts: { tool: 0, block: 0, final: 0 },
              };
            }
          }
          const pluginBoundMedia = await pluginBoundMediaPromise;
          assertWorkspaceRunOwnership?.();
          applyChatSendManagedMedia(ctx, pluginBoundMedia);
          const dispatchInbound = () => {
            assertWorkspaceRunOwnership?.();
            return dispatchInboundMessageWithProjectedDispatcher({
              ctx,
              cfg,
              toolsAllow,
              dispatcherOptions: replyDispatch.dispatcherOptions,
              onSessionMetadataChanges: (changes) =>
                changes.forEach((change) => emitSessionsChanged(context, change)),
              replyOptions: {
                prepareAssistantTranscriptMessage: replyDispatch.prepareAssistantTranscriptMessage,
                ...(admission.admittedSessionSettings
                  ? { admittedSessionSettings: admission.admittedSessionSettings }
                  : {}),
                runId: clientRunId,
                skillWorkshopProposalRevision,
                skillLibraryAuthoring,
                ...(cronCreatorAuthority
                  ? { cronCreatorAuthorityCapability: cronCreatorAuthority }
                  : {}),
                ...(isOperatorUiClient(clientInfo)
                  ? {
                      promptCacheKey: resolveWebchatPromptCacheKey({
                        agentId,
                        provider: resolvedSessionModel.provider,
                        model: resolvedSessionModel.model,
                        sessionKey: activeRunScopeKey,
                      }),
                    }
                  : {}),
                ...(supportsTaskSuggestions
                  ? { taskSuggestionDeliveryMode: "gateway" as const }
                  : {}),
                requestedSessionId,
                ...(restartSafeAdmission
                  ? {
                      expectedExistingSessionId: admittedSessionId,
                      pinExpectedExistingSession: true,
                      newlyCreatedSessionId: admission.initialSessionEntry?.sessionId,
                    }
                  : entry?.sessionId
                    ? { expectedExistingSessionId: entry.sessionId }
                    : {}),
                resumeRequestedSession: reconnectResumeRequested,
                onSessionPrepared: admission.onSessionPrepared,
                abortSignal: activeRunAbort.controller.signal,
                // Keep a Gateway-owned cancel identity after this chat.send
                // terminalizes while the prompt waits in followup/collect queue.
                onFollowupQueueDisposition: queuedFollowup.onQueueDisposition,
                onQueuedFollowupReplyBatch: queuedFollowup.onQueuedFollowupReplyBatch,
                turnAdoptionLifecycle: queuedFollowup.lifecycle,
                images: replyOptionImages,
                imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
                media: replyOptionMedia,
                thinkingLevelOverride: p.thinking,
                fastModeOverride: p.fastMode,
                queueModeOverride: p.queueMode,
                userTurnTranscriptRecorder: userTurnRecorder,
                ...(p.queueMode === "steer"
                  ? { messageInjectionDisposition: "rejected" as const }
                  : {}),
                ...(restartSafeAdmission ? { suppressNextUserMessagePersistence: true } : {}),
                fastModeAutoOnSecondsOverride: p.fastAutoOnSeconds,
                onAgentRunStart: (runId, _identity, options) => {
                  replyDispatchRun = options;
                  if (activeRunAbort.markExecutionStarted()) {
                    emitSessionsChanged(context, {
                      sessionKey,
                      agentId,
                      reason: "chat.run.started",
                    });
                  }
                  agentRunStarted = replyDispatch.captureAgentTranscriptStart();
                  emitServerTiming(
                    "agent-run-started",
                    runId !== clientRunId ? { agentRunId: runId } : undefined,
                    dispatchStartedAtMs,
                  );
                  const connId = typeof client?.connId === "string" ? client.connId : undefined;
                  const wantsToolEvents = hasGatewayClientCap(
                    client?.connect?.caps,
                    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                  );
                  if (connId && wantsToolEvents) {
                    context.registerToolEventRecipient(runId, connId);
                    // Register for any other active runs *in the same session* so
                    // late-joining clients (e.g. page refresh mid-response) receive
                    // in-progress tool events without leaking cross-session data.
                    const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(
                      cfg,
                      sessionKey,
                    );
                    const selectedSessionAgentId = selectedAgent.agentId;
                    for (const [activeRunId, active] of context.chatAbortControllers) {
                      const sameSelectedAgent =
                        selectedSessionAgentId !== undefined &&
                        chatRunBelongsToSelectedAgent({
                          agentId: active.agentId,
                          sessionKey: active.sessionKey,
                          defaultAgentId: compatibilityOwnerAgentId,
                          selectedAgentId: selectedSessionAgentId,
                        });
                      const sameSession = active.sessionKey === sessionKey && sameSelectedAgent;
                      if (activeRunId !== runId && sameSession) {
                        context.registerToolEventRecipient(activeRunId, connId);
                      }
                    }
                  }
                  return options?.completionSource;
                },
                onModelSelected: (modelSelection) => {
                  updateChatRunProvider(context.chatAbortControllers, {
                    runId: clientRunId,
                    providerId: modelSelection.provider,
                    authProviderId: resolveProviderIdForAuth(modelSelection.provider, {
                      config: cfg,
                    }),
                  });
                  replyDispatch.onModelSelected(modelSelection);
                  emitServerTiming(
                    "model-selected",
                    {
                      provider: modelSelection.provider,
                      model: modelSelection.model,
                    },
                    dispatchStartedAtMs,
                  );
                },
              },
            });
          };
          const dispatchWithRetry = () =>
            runAcceptedChatSendDispatch({
              operation: dispatchInbound,
              classify: classifyDispatchFailure,
              waitForRetry: (error) =>
                waitForAcceptedChatSendRetry(
                  { agentId, sessionKey, storePath },
                  error,
                  activeRunAbort.controller.signal,
                ),
            });
          const dispatchResult = await (cronCreatorAuthority && externalAuthorityAdmission
            ? externalAuthorityAdmission.run(
                cronCreatorAuthority,
                dispatchWithRetry,
                activeRunAbort.controller.signal,
              )
            : dispatchWithRetry());
          if (dispatchResult.beforeAgentRunBlocked === true) {
            userTurnRecorder.markBlocked();
          }
          return dispatchResult;
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: chatSendTraceAttributes,
        },
      ),
    )
    .then(async (dispatchResult) => {
      if (acceptedMessageInjection) {
        return;
      }
      emitServerTiming("dispatch-completed", undefined, dispatchStartedAtMs);
      const postDispatchStartedAtMs = performance.now();
      await measureDiagnosticsTimelineSpan(
        "gateway.chat_send.post_dispatch",
        async () => {
          const replyDispatchResult = replyDispatchRun?.getResult();
          const runtimeOutcome = replyDispatchResult?.terminalOutcome;
          const recordedOutcome = readAgentRunTerminalOutcome(dispatchResult);
          // ACP owns a rich terminal result; native runs record their outcome on dispatch.
          // Delivered warnings or source replies cannot replace either authoritative result.
          const runtimeClassification = runtimeOutcome
            ? classifyAgentRunTerminalOutcome(runtimeOutcome)
            : recordedOutcome && (recordedOutcome === "failed" ? "failure" : "success");
          const runtimeCancelled = runtimeClassification === "cancellation";
          const runtimeFailed =
            runtimeClassification === "failure" || runtimeClassification === "timeout";
          const returnedAgentErrorPayloads = replyDispatch.deliveredReplies
            .map((entryInner) => entryInner.payload)
            .filter((payload) => payload.isError);
          // Native streams cannot publish a host-authored warning. Give a warning-only
          // turn the normal reply owner without reclassifying the runtime outcome.
          const hasOnlyFinalWarnings =
            returnedAgentErrorPayloads.length > 0 &&
            replyDispatch.deliveredReplies.every(
              ({ kind, payload }) =>
                (kind === "final" && payload.isError === true) ||
                isReplyPayloadStatusNotice(payload),
            );
          const hasReturnedAgentError = runtimeClassification
            ? runtimeFailed
            : returnedAgentErrorPayloads.length > 0 &&
              (agentRunStarted || !isInternalTextSlashCommandTurn);
          const returnedAgentErrorMessage =
            runtimeOutcome?.error ??
            (formatReturnedAgentErrors(
              returnedAgentErrorPayloads
                .map((payload) => payload.text?.trim())
                .filter((text): text is string => Boolean(text)),
            ) ||
              (runtimeFailed ? "agent run failed" : undefined));
          if (
            !userTurnRecorder.hasPersisted() &&
            !userTurnRecorder.isBlocked() &&
            (hasReturnedAgentError ||
              (agentRunStarted &&
                returnedAgentErrorPayloads.length === 0 &&
                userTurnRecorder.hasRuntimePersistencePending()))
          ) {
            await persistGatewayUserTurnTranscriptBestEffort();
          }
          let finalizedSourceReply = false;
          // A dispatched runtime owns its persisted turn; this owner projects
          // only settled, post-hook replies. Native runtimes project their own stream.
          if (
            (!agentRunStarted || replyDispatchRun || hasOnlyFinalWarnings) &&
            !queuedFollowup.isEnqueued() &&
            !hasReturnedAgentError &&
            !context.chatRunState.hasAbortMarker(clientRunId)
          ) {
            await finalizeChatSendDispatchedReplies({
              accountId,
              context,
              deliveredReplies: replyDispatch.deliveredReplies,
              emitFirstAssistantServerTiming,
              foldCommandBlocks: isInternalTextSlashCommandTurn || replyDispatchRun !== undefined,
              persistUserTurnTranscript: persistGatewayUserTurnTranscriptBestEffort,
              session,
              suppressReplies: !replyDispatchRun && replyDispatch.hasAppendedWebchatAgentMedia(),
              runtimeOwnsTranscript: replyDispatchResult?.assistantTranscript !== undefined,
              state: runtimeCancelled ? "aborted" : "final",
              stopReason: runtimeOutcome?.stopReason,
            });
          } else if (!context.chatRunState.hasAbortMarker(clientRunId)) {
            finalizedSourceReply = await finalizeChatSendSourceReplies({
              accountId,
              context,
              deliveredReplies: replyDispatch.deliveredReplies,
              emitFirstAssistantServerTiming,
              hasReturnedAgentErrorPayloads: hasReturnedAgentError,
              session,
              suppressFinal: runtimeFailed,
            });
          }
          const shouldBroadcastAgentError =
            hasReturnedAgentError && (runtimeFailed || !finalizedSourceReply);
          if (!context.chatRunState.hasAbortMarker(clientRunId)) {
            if (shouldBroadcastAgentError) {
              broadcastChatError({
                context,
                runId: clientRunId,
                sessionKey,
                agentId,
                errorMessage: returnedAgentErrorMessage,
                errorKind: runtimeClassification === "timeout" ? "timeout" : undefined,
                stopReason: runtimeOutcome?.stopReason,
              });
            }
            const returnedAgentError = shouldBroadcastAgentError
              ? errorShape(
                  ErrorCodes.UNAVAILABLE,
                  returnedAgentErrorMessage ?? "agent returned an error payload",
                )
              : undefined;
            setGatewayDedupeEntry({
              dedupe: context.dedupe,
              key: `chat:${clientRunId}`,
              entry: {
                ts: Date.now(),
                ok: !shouldBroadcastAgentError,
                payload: shouldBroadcastAgentError
                  ? {
                      runId: clientRunId,
                      status: runtimeClassification === "timeout" ? "timeout" : "error",
                      summary: returnedAgentErrorMessage ?? "agent returned an error payload",
                      ...(runtimeOutcome ? { endedAt: runtimeOutcome.endedAt } : {}),
                      ...(runtimeOutcome?.stopReason
                        ? { stopReason: runtimeOutcome.stopReason }
                        : {}),
                    }
                  : runtimeCancelled
                    ? buildAbortedChatSendPayload({
                        runId: clientRunId,
                        endedAt: runtimeOutcome?.endedAt ?? Date.now(),
                        stopReason: runtimeOutcome?.stopReason,
                      })
                    : {
                        runId: clientRunId,
                        status: "ok",
                        ...(replyDispatchResult?.terminalOutcome?.stopReason
                          ? { stopReason: replyDispatchResult.terminalOutcome.stopReason }
                          : {}),
                      },
                ...(returnedAgentError ? { error: returnedAgentError } : {}),
              },
            });
          }
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: chatSendTraceAttributes,
        },
      );
      emitServerTiming(
        "post-dispatch-completed",
        {
          postDispatchMs: roundedChatSendTimingMs(performance.now() - postDispatchStartedAtMs),
        },
        dispatchStartedAtMs,
      );
      if (queuedFollowup.isEnqueued() && !context.chatRunState.hasAbortMarker(clientRunId)) {
        // Successful queue admission ends this client run. The later
        // aggregate/followup owns its own run id.
        broadcastChatFinal({
          context,
          runId: clientRunId,
          sessionKey,
          agentId,
        });
      }
    })
    .catch(dispatchErrorLifecycle.handleError);
  void (async () => {
    try {
      await dispatch;
    } finally {
      await dispatchErrorLifecycle.finalize();
      // Terminal lifecycle can precede owner release; publish exact liveness after cleanup.
      emitSessionsChanged(context, { sessionKey, agentId, reason: "chat.run.settled" });
      if (userTurnRecorder.isBlocked() && attachments.offloadedRefs.length > 0) {
        // A blocked turn persists only the redacted block reason — no media
        // markers — so the prepared inbound media stays unreferenced forever
        // (sweep is off by default). Same custody rule as the pre-ACK owner
        // in chat-send-admission.ts: unreferenced staged media is discarded.
        void discardPreparedInboundMedia(attachments.offloadedRefs);
      }
    }
  })();
  // Title work starts at turn admission, concurrently with the launched run. It must never run
  // serially before dispatch (a cold utility runtime can starve the turn) or wait for completion
  // (long or interrupted first turns would silently remain untitled, and restart loses the chain).
  scheduleChatDashboardSessionTitle({
    admittedSessionId,
    agentId,
    cfg,
    context,
    request,
    sessionKey,
    sessionLoadOptions: session.sessionLoadOptions,
    storePath: session.storePath,
  });
}
