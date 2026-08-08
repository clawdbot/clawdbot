// chat.send owns admission, ACK timing, detached dispatch, and terminalization.
import { performance } from "node:perf_hooks";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { dispatchInboundMessageWithProjectedDispatcher } from "../../auto-reply/dispatch.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  emitDiagnosticsTimelineEvent,
  measureDiagnosticsTimelineSpan,
} from "../../infra/diagnostics-timeline.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { updateChatRunProvider } from "../chat-abort.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import { hasGatewayAdminScope } from "./chat-origin-routing.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import {
  resolveWebchatPromptCacheKey,
  scheduleChatDashboardSessionTitle,
} from "./chat-send-background.js";
import {
  createChatSendDispatchErrorLifecycle,
  handleChatSendSetupError,
} from "./chat-send-dispatch-errors.js";
import {
  beginChatSendMessageInjection,
  finalizeAcceptedChatSendMessageInjection,
} from "./chat-send-message-injection.js";
import { finalizeChatSendNonAgentReplies } from "./chat-send-nonagent-finalization.js";
import { ACTIVE_RUN_CHANGED_ERROR_REASON } from "./chat-send-pre-admission.js";
import {
  applyChatSendReplyContextFields,
  resolveChatSendReplyContext,
} from "./chat-send-reply-context.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";
import { applyChatSendManagedMedia, prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  chatSendAckServerTimingAttributes,
  emitOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
  shouldIncludeChatSendAckServerTiming,
  type ChatSendServerTimingPhase,
} from "./chat-server-timing.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { gatewayClientSenderFields } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function handleChatSend(
  { params, respond, context, client }: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
): Promise<void> {
  const setup = await prepareAndAdmitChatSend(
    { params, respond, context, client },
    onAdmissionOwned,
  );
  if (!setup) {
    return;
  }
  const { normalizedRequest, preparedSession, admitted } = setup;
  const {
    chatSendReceivedAtMs,
    clientInfo,
    supportsTaskSuggestions,
    p,
    systemInputProvenance,
    rawMessage,
    reconnectResumeRequested,
  } = normalizedRequest.value;
  const {
    clientRunId,
    sessionLoadOptions,
    sessionLoadMs,
    cfg,
    storePath,
    entry,
    sessionKey,
    sessionRoutingChanged,
    selectedAgent,
    requestedSessionId,
    backingSessionId,
    agentId,
    activeRunScopeKey,
    expectedLeafEntryId,
    resolvedSessionModel,
    now,
  } = preparedSession.value;
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    finishAbortedChatSend,
    gatewayWorkAdmission,
    lifecycleGeneration,
    messageInjectionTarget,
    retainGatewayWorkAdmission,
    restartSafeAdmission,
    setReleaseGatewayRootContinuation,
  } = admitted.value;
  const preparedAttachments = await prepareChatSendAttachments({
    request: normalizedRequest.value,
    session: preparedSession.value,
    admission: admitted.value,
    respond,
    context,
  });
  if (!preparedAttachments.ok) {
    return;
  }
  if (activeRunAbort.controller.signal.aborted) {
    finishAbortedChatSend();
    return;
  }

  // Attachment preparation can suspend. Recheck immediately before the
  // synchronous ACK path so aborts and hot routing reloads cannot cross it.
  if (sessionRoutingChanged(context.getRuntimeConfig())) {
    admitted.value.rejectSessionRoutingChanged();
    return;
  }
  const { imageOrder, prepareAttachmentsMs } = preparedAttachments.value;

  const admissionStartedAt = Date.now();
  const terminalizeRestartSafeAdmission = async (terminalState: {
    retryable: boolean;
    status: "failed" | "killed";
  }): Promise<boolean> =>
    await terminalizeRestartSafeChatAdmission({
      admittedSessionId,
      clientRunId,
      sessionKey,
      startedAt: admissionStartedAt,
      storePath,
      ...terminalState,
    });

  try {
    const userTurn = createGatewayChatUserTurnController({
      agentId,
      cfg,
      clientRunId,
      initialSessionId: admittedSessionId,
      now,
      ...(systemInputProvenance ? { provenance: systemInputProvenance } : {}),
      rawMessage,
      ...(restartSafeAdmission ? { restartAdmission: restartSafeAdmission } : {}),
      ...gatewayClientSenderFields(client),
      senderIsOwner: hasGatewayAdminScope(client),
      sessionKey,
      ...(sessionLoadOptions ? { sessionLoadOptions } : {}),
      startedAt: admissionStartedAt,
      traceAttributes: chatSendTraceAttributes,
      warn: (message) => context.logGateway.warn(message),
    });
    const {
      persist: persistGatewayUserTurnTranscript,
      persistBestEffort: persistGatewayUserTurnTranscriptBestEffort,
      recorder: userTurnRecorder,
    } = userTurn;
    if (restartSafeAdmission) {
      const persistedUserTurn = await persistGatewayUserTurnTranscript();
      const admittedEntry = persistedUserTurn?.sessionEntry;
      // A matching idempotency row and lifecycle claim commit atomically, so
      // retries adopt the durable turn without submitting it twice.
      if (
        !persistedUserTurn ||
        admittedEntry?.status !== "running" ||
        admittedEntry.restartRecoveryDeliveryRunId !== clientRunId
      ) {
        throw new Error("chat turn was not durably admitted");
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (activeRunAbort.entry) {
          activeRunAbort.entry.abortStopReason = "restart";
        }
        activeRunAbort.controller.abort(createAgentRunRestartAbortError());
      }
      if (activeRunAbort.controller.signal.aborted) {
        if (
          !(await terminalizeRestartSafeAdmission({
            retryable: activeRunAbort.entry?.abortStopReason === "restart",
            status: "killed",
          }))
        ) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        finishAbortedChatSend();
        return;
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        if (!(await terminalizeRestartSafeAdmission({ retryable: true, status: "failed" }))) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        admitted.value.rejectSessionRoutingChanged();
        return;
      }
    }

    const {
      accountId,
      ctx,
      isInternalTextSlashCommandTurn,
      pluginBoundMediaPromise,
      queuedFollowupOwnerKey,
      replyOptionImages,
      replyOptionMedia,
    } = prepareChatSendUserTurn({
      request: normalizedRequest.value,
      session: preparedSession.value,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      logGateway: context.logGateway,
      userTurn,
    });
    const beginCapturedMessageInjection = () =>
      messageInjectionTarget && !isInternalTextSlashCommandTurn
        ? beginChatSendMessageInjection({
            target: messageInjectionTarget,
            text: ctx.BodyForAgent ?? ctx.Body ?? rawMessage,
            replyContext: p.replyToId
              ? { body: ctx.BodyForAgent ?? ctx.Body ?? rawMessage, cfg, ctx, sessionEntry: entry }
              : undefined,
            images: replyOptionImages,
            imageOrder,
            media: replyOptionMedia,
            queueSettings: {
              cfg,
              channel: ctx.Provider,
              sessionEntry: entry,
              inlineMode: p.queueMode,
            },
            taskSuggestionDeliveryMode: supportsTaskSuggestions ? "gateway" : undefined,
            userTurnTranscriptRecorder: userTurnRecorder,
          })
        : undefined;
    let messageInjectionAttempt = p.replyToId ? undefined : beginCapturedMessageInjection();
    if (messageInjectionTarget && !isInternalTextSlashCommandTurn) {
      // Accepted injection never consumes plugin-bound media, but the shared
      // persistence promise still needs a rejection observer.
      void pluginBoundMediaPromise.catch(() => undefined);
    }
    if (messageInjectionAttempt?.rejectBeforeAck) {
      return admitted.value.rejectActiveLeafChanged();
    }

    const serverTiming = shouldIncludeChatSendAckServerTiming(clientInfo)
      ? {
          receivedToAckMs: roundedChatSendTimingMs(performance.now() - chatSendReceivedAtMs),
          loadSessionMs: sessionLoadMs,
          ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
        }
      : undefined;
    const chatSendTiming: ChatRunTiming | undefined =
      serverTiming && typeof client?.connId === "string" && client.connId.trim()
        ? {
            ackedAtMs: performance.now(),
            connId: client.connId.trim(),
            receivedAtMs: chatSendReceivedAtMs,
          }
        : undefined;
    context.addChatRun(clientRunId, {
      sessionKey,
      agentId: selectedAgent.agentId,
      clientRunId,
      ...(chatSendTiming ? { chatSendTiming } : {}),
    });
    const ackPayload = {
      runId: clientRunId,
      status: "started" as const,
      ...(serverTiming ? { serverTiming } : {}),
    };
    emitDiagnosticsTimelineEvent(
      {
        type: "mark",
        name: "gateway.chat_send.ack_ready",
        phase: "agent-turn",
        attributes: {
          ...chatSendTraceAttributes,
          ackStatus: ackPayload.status,
          ...chatSendAckServerTimingAttributes(serverTiming),
        },
      },
      { config: cfg },
    );
    respond(true, ackPayload, undefined, { runId: clientRunId });
    const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
    scheduleChatDashboardSessionTitle({
      admittedSessionId,
      agentId,
      cfg,
      context,
      entry,
      rawMessage,
      sessionKey,
      sessionLoadOptions,
      storePath,
    });
    // Resolve the reply target from session history in parallel with the
    // remaining dispatch prep so replies do not delay the first model call.
    // Skipped entirely for non-reply sends so their dispatch path keeps its
    // existing await ordering.
    const replyContextFieldsPromise = p.replyToId
      ? resolveChatSendReplyContext({
          replyToId: p.replyToId,
          cfg,
          agentId,
          sessionKey,
          sessionEntry: entry,
          storePath,
          userSenderLabel: clientInfo?.displayName,
          warn: (message) => context.logGateway.warn(message),
        })
      : undefined;
    let agentRunStarted = false;
    const replyDispatch = createChatSendReplyDispatch({
      accountId,
      isAgentRunStarted: () => agentRunStarted,
      logGateway: context.logGateway,
      session: preparedSession.value,
      userTurnRecorder,
    });
    let queuedFollowupEnqueued = false;
    let releaseQueuedFollowupWorkAdmission: (() => void) | undefined;
    const dispatchErrorLifecycle = createChatSendDispatchErrorLifecycle({
      admission: admitted.value,
      context,
      isQueuedFollowupEnqueued: () => queuedFollowupEnqueued,
      persistUserTurnTranscript: persistGatewayUserTurnTranscript,
      session: preparedSession.value,
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
            if (replyContextFieldsPromise) {
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
                  session: preparedSession.value,
                  startedAt: admissionStartedAt,
                  target: messageInjectionTarget!,
                  targetRunId: messageInjectionAttempt.targetRunId,
                });
                return {
                  queuedFinal: false,
                  counts: { tool: 0, block: 0, final: 0 },
                };
              }
              if (p.replyToId) {
                throw new Error(ACTIVE_RUN_CHANGED_ERROR_REASON);
              }
            }
            applyChatSendManagedMedia(ctx, await pluginBoundMediaPromise);
            const dispatchResult = await dispatchInboundMessageWithProjectedDispatcher({
              ctx,
              cfg,
              dispatcherOptions: replyDispatch.dispatcherOptions,
              onSessionMetadataChanges: (changes) => {
                for (const change of changes) {
                  emitSessionsChanged(context, change);
                }
              },
              replyOptions: {
                runId: clientRunId,
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
                turnAdoptionLifecycle: {
                  // Gateway cancel identity only — share collect key via ownerKey.
                  admission: "cancel-only",
                  ...(expectedLeafEntryId !== undefined
                    ? { originatingLeafEntryId: expectedLeafEntryId }
                    : {}),
                  ownerKey: queuedFollowupOwnerKey,
                  onAdopted: async () => {},
                  onDeferred: () => {
                    queuedFollowupEnqueued = registerQueuedChatTurn({
                      chatQueuedTurns: context.chatQueuedTurns,
                      runId: clientRunId,
                      controller: activeRunAbort.controller,
                      sessionId: backingSessionId ?? clientRunId,
                      sessionKey,
                      agentId: selectedAgent.agentId,
                      ownerConnId: normalizeOptionalText(client?.connId),
                      ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
                    });
                    if (queuedFollowupEnqueued && !releaseQueuedFollowupWorkAdmission) {
                      // The detached dispatch can finish before this queued turn is
                      // adopted. Retain the session fence across that ownership gap.
                      releaseQueuedFollowupWorkAdmission = retainGatewayWorkAdmission();
                    }
                    return queuedFollowupEnqueued;
                  },
                  onCancellationRetired: () => {
                    retireQueuedChatTurnCancellation(
                      context.chatQueuedTurns,
                      clientRunId,
                      activeRunAbort.controller,
                    );
                  },
                  onSettled: () => {
                    completeQueuedChatTurn(
                      context.chatQueuedTurns,
                      clientRunId,
                      activeRunAbort.controller,
                    );
                    releaseQueuedFollowupWorkAdmission?.();
                    releaseQueuedFollowupWorkAdmission = undefined;
                  },
                },
                images: replyOptionImages,
                imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
                media: replyOptionMedia,
                thinkingLevelOverride: p.thinking,
                fastModeOverride: p.fastMode,
                queueModeOverride: p.queueMode,
                userTurnTranscriptRecorder: userTurnRecorder,
                ...(messageInjectionTarget && !isInternalTextSlashCommandTurn
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
                    const defaultAgentId = resolveDefaultAgentId(cfg);
                    const selectedGlobalAgentId =
                      sessionKey === "global"
                        ? (selectedAgent.agentId ?? defaultAgentId)
                        : undefined;
                    for (const [activeRunId, active] of context.chatAbortControllers) {
                      const activeGlobalAgentId =
                        active.sessionKey === "global"
                          ? (active.agentId ?? defaultAgentId)
                          : undefined;
                      const sameSelectedGlobalAgent =
                        sessionKey === "global" &&
                        selectedGlobalAgentId !== undefined &&
                        activeGlobalAgentId === selectedGlobalAgentId;
                      const sameSession =
                        active.sessionKey === sessionKey &&
                        (sessionKey !== "global" || sameSelectedGlobalAgent);
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
            // WebChat persistence has two owners. Agent runs persist model-visible turns
            // through OpenClaw runtime's SessionManager; this dispatcher only owns live delivery payloads.
            // Do not blindly mirror agent-run final payloads into JSONL or chat.history can
            // duplicate normal embedded-agent assistant turns. The non-agent branch below has no
            // runtime-owned assistant turn, so it appends a gateway-injected assistant entry before
            // broadcasting the final UI event.
            if (!agentRunStarted && !queuedFollowupEnqueued) {
              await finalizeChatSendNonAgentReplies({
                accountId,
                context,
                deliveredReplies: replyDispatch.deliveredReplies,
                emitFirstAssistantServerTiming,
                foldCommandBlocks: isInternalTextSlashCommandTurn,
                persistUserTurnTranscript: persistGatewayUserTurnTranscriptBestEffort,
                session: preparedSession.value,
                suppressReplies: replyDispatch.hasAppendedWebchatAgentMedia(),
              });
            } else {
              broadcastedSourceReplyFinal = await finalizeChatSendSourceReplies({
                accountId,
                context,
                deliveredReplies: replyDispatch.deliveredReplies,
                emitFirstAssistantServerTiming,
                hasReturnedAgentErrorPayloads: returnedAgentErrorPayloads.length > 0,
                session: preparedSession.value,
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
        if (queuedFollowupEnqueued && !context.chatRunState.hasAbortMarker(clientRunId)) {
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
      .finally(dispatchErrorLifecycle.finalize);
  } catch (err) {
    await handleChatSendSetupError({
      admission: admitted.value,
      context,
      error: err,
      respond,
      session: preparedSession.value,
      terminalizeRestartSafeAdmission,
    });
  }
}
