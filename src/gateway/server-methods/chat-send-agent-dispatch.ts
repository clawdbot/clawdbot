// Detached chat.send dispatch owns runtime delivery, post-dispatch persistence, and terminalization.
import { performance } from "node:perf_hooks";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { dispatchInboundMessageWithProjectedDispatcher } from "../../auto-reply/dispatch.js";
import type { ReplyMessageInjectionAttempt } from "../../auto-reply/reply/reply-run-registry.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { updateChatRunProvider } from "../chat-abort.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { prepareChatSendAttachments } from "./chat-send-attachments.js";
import {
  resolveWebchatPromptCacheKey,
  scheduleChatDashboardSessionTitle,
} from "./chat-send-background.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import { finalizeAcceptedChatSendMessageInjection } from "./chat-send-message-injection.js";
import { finalizeChatSendNonAgentReplies } from "./chat-send-nonagent-finalization.js";
import {
  applyChatSendReplyContextFields,
  type ChatSendReplyContextFields,
} from "./chat-send-reply-context.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
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
  terminalizeRestartSafeAdmission: (terminalState: {
    retryable: boolean;
    status: "failed" | "killed";
  }) => Promise<boolean>;
  timing: {
    chatSendAckedAtMs: number;
    chatSendTiming: ChatRunTiming | undefined;
  };
  turn: ReturnType<typeof prepareChatSendUserTurn>;
  userTurn: ReturnType<typeof createGatewayChatUserTurnController>;
};

export function startChatDispatch(params: StartChatDispatchParams): void {
  const {
    admissionStartedAt,
    admission,
    attachments,
    client,
    context,
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
    setReleaseGatewayRootContinuation,
  } = admission;
  const {
    activeRunScopeKey,
    agentId,
    backingSessionId,
    cfg,
    clientRunId,
    entry,
    expectedLeafEntryId,
    expectedRunId,
    requestedSessionId,
    resolvedSessionModel,
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
  const replyDispatch = createChatSendReplyDispatch({
    accountId,
    isAgentRunStarted: () => agentRunStarted,
    logGateway: context.logGateway,
    session,
    userTurnRecorder,
  });
  const queuedFollowup = createChatSendTurnAdoptionLifecycle({
    chatQueuedTurns: context.chatQueuedTurns,
    runId: clientRunId,
    controller: activeRunAbort.controller,
    sessionId: backingSessionId ?? clientRunId,
    sessionKey,
    agentId: selectedAgent.agentId,
    ownerConnId: client?.connId,
    ownerDeviceId: client?.connect?.device?.id,
    ownerKey: queuedFollowupOwnerKey,
    ...(expectedLeafEntryId !== undefined ? { originatingLeafEntryId: expectedLeafEntryId } : {}),
    hasCronCreatorAuthority: cronCreatorAuthority !== undefined,
    retainWorkAdmission: retainGatewayWorkAdmission,
  });
  const dispatchErrorLifecycle = createChatSendDispatchErrorLifecycle({
    admission,
    context,
    isQueuedFollowupEnqueued: queuedFollowup.isEnqueued,
    persistUserTurnTranscript: persistGatewayUserTurnTranscript,
    session,
    terminalizeRestartSafeAdmission,
    userTurnRecorder,
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
  let acceptedMessageInjection = false;
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
  // Reserve the detached dispatch before this request releases its root. Otherwise
  // its inherited ALS context becomes retired and rejects queued/session work.
  setReleaseGatewayRootContinuation(retainGatewayRootWorkAdmissionContinuation() ?? undefined);
  void replyDispatch
    .runAgentMediaTranscript(gatewayWorkAdmission, () =>
      measureDiagnosticsTimelineSpan(
        "gateway.chat_send.dispatch_inbound",
        async () => {
          if (replyContextFieldsPromise && !preAckReplyContextPromise) {
            applyChatSendReplyContextFields(ctx, await replyContextFieldsPromise);
            messageInjectionAttempt = beginCapturedMessageInjection();
          }
          if (messageInjectionAttempt) {
            const outcome = await messageInjectionAttempt.outcome;
            if (outcome.status === "accepted") {
              acceptedMessageInjection = true;
              await finalizeAcceptedChatSendMessageInjection({
                context,
                ctx,
                outcome,
                persistUserTurnTranscriptBestEffort: persistGatewayUserTurnTranscriptBestEffort,
                session,
                startedAt: admissionStartedAt,
                target: messageInjectionTarget!,
                targetRunId: messageInjectionAttempt.targetRunId,
              });
              return {
                queuedFinal: false,
                counts: { tool: 0, block: 0, final: 0 },
              };
            }
          }
          applyChatSendManagedMedia(ctx, await pluginBoundMediaPromise);
          const dispatchInbound = () =>
            dispatchInboundMessageWithProjectedDispatcher({
              ctx,
              cfg,
              dispatcherOptions: replyDispatch.dispatcherOptions,
              onSessionMetadataChanges: (changes) =>
                changes.forEach((change) => emitSessionsChanged(context, change)),
              replyOptions: {
                runId: clientRunId,
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
                    }
                  : entry?.sessionId
                    ? { expectedExistingSessionId: entry.sessionId }
                    : {}),
                resumeRequestedSession: reconnectResumeRequested,
                onSessionPrepared: (binding) => {
                  if (binding.sessionKey === sessionKey) {
                    userTurn.setAcceptedSessionId(binding.sessionId);
                  }
                },
                abortSignal: activeRunAbort.controller.signal,
                // Keep a Gateway-owned cancel identity after this chat.send
                // terminalizes while the prompt waits in followup/collect queue.
                onFollowupQueueDisposition: (reason) => {
                  context.logGateway.info("chat queue turn intentionally skipped", {
                    runId: clientRunId,
                    sessionKey,
                    outcome: "skipped",
                    reason,
                  });
                },
                turnAdoptionLifecycle: queuedFollowup.lifecycle,
                images: replyOptionImages,
                imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
                media: replyOptionMedia,
                thinkingLevelOverride: p.thinking,
                fastModeOverride: p.fastMode,
                queueModeOverride: p.queueMode,
                userTurnTranscriptRecorder: userTurnRecorder,
                ...((messageInjectionTarget && !isInternalTextSlashCommandTurn) ||
                (p.queueMode === "steer" && expectedRunId !== undefined)
                  ? { messageInjectionAttempted: true as const }
                  : {}),
                ...(restartSafeAdmission ? { suppressNextUserMessagePersistence: true } : {}),
                fastModeAutoOnSecondsOverride: p.fastAutoOnSeconds,
                onAgentRunStart: (runId) => {
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
          const dispatchResult = await (cronCreatorAuthority && externalAuthorityAdmission
            ? externalAuthorityAdmission.run(
                cronCreatorAuthority,
                dispatchInbound,
                activeRunAbort.controller.signal,
              )
            : dispatchInbound());
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
    .then(async () => {
      if (acceptedMessageInjection) {
        return;
      }
      emitServerTiming("dispatch-completed", undefined, dispatchStartedAtMs);
      const postDispatchStartedAtMs = performance.now();
      await measureDiagnosticsTimelineSpan(
        "gateway.chat_send.post_dispatch",
        async () => {
          const returnedAgentErrorPayloads = agentRunStarted
            ? replyDispatch.deliveredReplies
                .map((entryInner) => entryInner.payload)
                .filter((payload) => payload.isError)
            : [];
          const returnedAgentErrorMessage =
            returnedAgentErrorPayloads
              .map((payload) => payload.text?.trim())
              .filter((text): text is string => Boolean(text))
              .join(" | ") || undefined;
          if (
            agentRunStarted &&
            returnedAgentErrorPayloads.length > 0 &&
            !userTurnRecorder.hasPersisted() &&
            !userTurnRecorder.isBlocked()
          ) {
            await persistGatewayUserTurnTranscriptBestEffort();
          }
          if (
            agentRunStarted &&
            returnedAgentErrorPayloads.length === 0 &&
            !userTurnRecorder.hasPersisted() &&
            !userTurnRecorder.isBlocked() &&
            userTurnRecorder.hasRuntimePersistencePending()
          ) {
            await persistGatewayUserTurnTranscriptBestEffort();
          }
          let broadcastedSourceReplyFinal = false;
          // Agent runs persist model-visible turns through SessionManager; this dispatcher owns
          // live delivery. Mirroring agent finals would duplicate normal assistant turns. The
          // non-agent branch has no runtime-owned turn, so it appends one before broadcasting.
          if (!agentRunStarted && !queuedFollowup.isEnqueued()) {
            await finalizeChatSendNonAgentReplies({
              accountId,
              context,
              deliveredReplies: replyDispatch.deliveredReplies,
              emitFirstAssistantServerTiming,
              foldCommandBlocks: isInternalTextSlashCommandTurn,
              persistUserTurnTranscript: persistGatewayUserTurnTranscriptBestEffort,
              session,
              suppressReplies: replyDispatch.hasAppendedWebchatAgentMedia(),
            });
          } else {
            broadcastedSourceReplyFinal = await finalizeChatSendSourceReplies({
              accountId,
              context,
              deliveredReplies: replyDispatch.deliveredReplies,
              emitFirstAssistantServerTiming,
              hasReturnedAgentErrorPayloads: returnedAgentErrorPayloads.length > 0,
              session,
            });
          }
          const shouldBroadcastAgentError =
            returnedAgentErrorPayloads.length > 0 && !broadcastedSourceReplyFinal;
          if (shouldBroadcastAgentError) {
            broadcastChatError({
              context,
              runId: clientRunId,
              sessionKey,
              agentId,
              errorMessage: returnedAgentErrorMessage,
            });
          }
          if (!context.chatRunState.hasAbortMarker(clientRunId)) {
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
                      status: "error" as const,
                      summary: returnedAgentErrorMessage ?? "agent returned an error payload",
                    }
                  : { runId: clientRunId, status: "ok" as const },
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
    .catch(dispatchErrorLifecycle.handleError)
    .finally(() => {
      dispatchErrorLifecycle.finalize();
      // Cosmetic title work starts only after the accepted turn finishes. Starting it
      // before dispatch can make a cold utility runtime starve the user's real turn.
      scheduleChatDashboardSessionTitle({
        admittedSessionId,
        agentId,
        cfg,
        context,
        entry,
        request,
        sessionKey,
        sessionLoadOptions: session.sessionLoadOptions,
        storePath: session.storePath,
      });
    });
}
