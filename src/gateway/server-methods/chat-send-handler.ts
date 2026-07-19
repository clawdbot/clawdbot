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
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  clearAgentRunContext,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
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
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { ensureChatQueuedTurns } from "./chat-abort-runtime.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import { hasGatewayAdminScope } from "./chat-origin-routing.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import { admitChatSend } from "./chat-send-admission.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import {
  resolveWebchatPromptCacheKey,
  scheduleChatDashboardSessionTitle,
} from "./chat-send-background.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";
import { finalizeChatSendNonAgentReplies } from "./chat-send-nonagent-finalization.js";
import {
  respondChatSessionRoutingChanged,
  runChatSendPreAdmission,
} from "./chat-send-pre-admission.js";
import {
  applyChatSendReplyContextFields,
  resolveChatSendReplyContext,
} from "./chat-send-reply-context.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";
import { applyChatSendManagedMediaFields, prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  chatSendAckServerTimingAttributes,
  emitOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
  shouldIncludeChatSendAckServerTiming,
  type ChatSendServerTimingPhase,
} from "./chat-server-timing.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";

export const handleChatSend: GatewayRequestHandlers["chat.send"] = async ({
  params,
  respond,
  context,
  client,
}) => {
  const normalizedRequest = normalizeChatSendRequest({ params, client });
  if (!normalizedRequest.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, normalizedRequest.error));
    return;
  }
  const {
    chatSendReceivedAtMs,
    clientInfo,
    supportsTaskSuggestions,
    p,
    systemInputProvenance,
    rawMessage,
    reconnectResumeRequested,
  } = normalizedRequest.value;
  const preparedSession = prepareChatSendSession({
    request: normalizedRequest.value,
    context,
    client,
  });
  if (!preparedSession.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, preparedSession.error));
    return;
  }
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
    resolvedSessionModel,
    now,
  } = preparedSession.value;
  const shouldAdmit = await runChatSendPreAdmission({
    request: normalizedRequest.value,
    session: preparedSession.value,
    respond,
    context,
    client,
  });
  if (!shouldAdmit) {
    return;
  }
  const admitted = await admitChatSend({
    request: normalizedRequest.value,
    session: preparedSession.value,
    respond,
    context,
    client,
  });
  if (!admitted.ok) {
    return;
  }
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    cleanupAdmittedRun,
    finishAbortedChatSend,
    gatewayWorkAdmission,
    lifecycleGeneration,
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
    cleanupAdmittedRun({ force: true });
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    respondChatSessionRoutingChanged(respond);
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
        cleanupAdmittedRun({ force: true });
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        respondChatSessionRoutingChanged(respond);
        return;
      }
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
    const {
      accountId,
      ctx,
      isInternalTextSlashCommandTurn,
      pluginBoundMediaFieldsPromise,
      queuedFollowupOwnerKey,
      replyOptionImages,
    } = prepareChatSendUserTurn({
      request: normalizedRequest.value,
      session: preparedSession.value,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      logGateway: context.logGateway,
      userTurn,
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
    const { deliveredReplies, dispatcher, hasAppendedWebchatAgentMedia, onModelSelected } =
      createChatSendReplyDispatch({
        accountId,
        isAgentRunStarted: () => agentRunStarted,
        logGateway: context.logGateway,
        session: preparedSession.value,
        userTurnRecorder,
      });
    let queuedFollowupEnqueued = false;
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
    void gatewayWorkAdmission
      .run(() =>
        measureDiagnosticsTimelineSpan(
          "gateway.chat_send.dispatch_inbound",
          async () => {
            applyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);
            if (replyContextFieldsPromise) {
              applyChatSendReplyContextFields(ctx, await replyContextFieldsPromise);
            }
            const dispatchResult = await dispatchInboundMessage({
              ctx,
              cfg,
              dispatcher,
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
                turnAdoptionLifecycle: {
                  // Gateway cancel identity only — share collect key via ownerKey.
                  admission: "cancel-only",
                  ownerKey: queuedFollowupOwnerKey,
                  onAdopted: async () => {},
                  onDeferred: () => {
                    queuedFollowupEnqueued = registerQueuedChatTurn({
                      chatQueuedTurns: ensureChatQueuedTurns(context),
                      runId: clientRunId,
                      controller: activeRunAbort.controller,
                      sessionId: backingSessionId ?? clientRunId,
                      sessionKey,
                      agentId: selectedAgent.agentId,
                      ownerConnId: normalizeOptionalText(client?.connId),
                      ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
                    });
                    return queuedFollowupEnqueued;
                  },
                  onCancellationRetired: () => {
                    retireQueuedChatTurnCancellation(
                      ensureChatQueuedTurns(context),
                      clientRunId,
                      activeRunAbort.controller,
                    );
                  },
                  onSettled: () => {
                    completeQueuedChatTurn(
                      ensureChatQueuedTurns(context),
                      clientRunId,
                      activeRunAbort.controller,
                    );
                  },
                },
                images: replyOptionImages,
                imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
                thinkingLevelOverride: p.thinking,
                fastModeOverride: p.fastMode,
                queueModeOverride: p.queueMode,
                userTurnTranscriptRecorder: userTurnRecorder,
                ...(restartSafeAdmission ? { suppressNextUserMessagePersistence: true } : {}),
                fastModeAutoOnSecondsOverride: p.fastAutoOnSeconds,
                onAgentRunStart: (runId) => {
                  agentRunStarted = true;
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
                  onModelSelected(modelSelection);
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
        emitServerTiming("dispatch-completed", undefined, dispatchStartedAtMs);
        const postDispatchStartedAtMs = performance.now();
        await measureDiagnosticsTimelineSpan(
          "gateway.chat_send.post_dispatch",
          async () => {
            const returnedAgentErrorPayloads = agentRunStarted
              ? deliveredReplies
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
                deliveredReplies,
                emitFirstAssistantServerTiming,
                foldCommandBlocks: isInternalTextSlashCommandTurn,
                persistUserTurnTranscript: persistGatewayUserTurnTranscriptBestEffort,
                session: preparedSession.value,
                suppressReplies: hasAppendedWebchatAgentMedia(),
              });
            } else {
              broadcastedSourceReplyFinal = await finalizeChatSendSourceReplies({
                accountId,
                context,
                deliveredReplies,
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
            if (!context.chatAbortedRuns.has(clientRunId)) {
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
        if (queuedFollowupEnqueued && !context.chatAbortedRuns.has(clientRunId)) {
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
    if (restartSafeAdmission) {
      const terminalized = await terminalizeRestartSafeAdmission({
        retryable: true,
        status: "failed",
      }).catch((terminalizeError: unknown) => {
        context.logGateway.warn(
          `failed to release restart-safe chat admission after setup error: ${formatForLog(
            terminalizeError,
          )}`,
        );
        return false;
      });
      if (terminalized) {
        emitSessionsChanged(context, {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          reason: "chat.dispatch-error",
        });
      }
    }
    cleanupAdmittedRun({ force: true });
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    context.removeChatRun(clientRunId, clientRunId, sessionKey);
    const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
    const payload = {
      runId: clientRunId,
      status: "error" as const,
      summary: String(err),
    };
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      entry: {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      },
    });
    respond(false, payload, error, {
      runId: clientRunId,
      error: formatForLog(err),
    });
    broadcastChatError({
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
      errorMessage: String(err),
    });
  }
};
