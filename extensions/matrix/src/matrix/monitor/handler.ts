import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createChannelInboundEnvelopeBuilder,
  hasFinalInboundReplyDispatch,
  type InboundEventKind,
  resolveInboundReplyDispatchCounts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { isPollEventType } from "../poll-types.js";
import type { LocationMessageEventContent } from "../sdk.js";
import { normalizeMatrixUserId } from "./allowlist.js";
import { resolveMatrixMonitorLiveUserAllowlist } from "./config.js";
import { resolveMatrixInboundContext } from "./handler-context.js";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import {
  markTrackedRoomIfFirst,
  shouldDeferMatrixAudioPreflightForRoomIngress,
} from "./handler-helpers.js";
import {
  type MatrixIngressAccessParams,
  resolveMatrixIngressAccess,
} from "./handler-ingress-access.js";
import { resolveMatrixIngressContent } from "./handler-ingress-content.js";
import { readMatrixIngressPrefix } from "./handler-ingress-prefix.js";
import { createMatrixHandlerReplyRuntime } from "./handler-reply-runtime.js";
import { loadMatrixSendModule } from "./handler-runtime.js";
import { createMatrixHandlerState } from "./handler-state.js";
import { createMatrixTurnTakingPreflight } from "./handler-turn-taking-preflight.js";
import type { MatrixHandlerRuntimeConfig, MatrixMonitorHandlerParams } from "./handler-types.js";
import { createMatrixReceiverAccessPreparer } from "./ingress-access-snapshot.js";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import { createRoomHistoryTracker } from "./room-history.js";
import { bindMatrixSourceFinalizationRequest } from "./source-finalization-request.js";
import { createMatrixThreadContextResolver } from "./thread-context.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

// Core emits this stable error code across the plugin boundary; Matrix cannot import the
// core lifecycle module that owns it. Keep the notice actionable or replay will dead-end.
const SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE = "SESSION_RESTART_RECOVERY_TOMBSTONE";
const RESTART_RECOVERY_TOMBSTONE_NOTICE =
  "This session ended during gateway restart recovery and cannot accept more messages. Send /new or /reset to start a replacement session.";

export function createMatrixRoomMessageHandler(params: MatrixMonitorHandlerParams) {
  const {
    client,
    core,
    cfg,
    accountId,
    runtime,
    logger,
    logVerboseMessage,
    allowFromResolvedEntries = [],
    groupAllowFromResolvedEntries = [],
    configuredBotUserIds = new Set<string>(),
    groupPolicy,
    replyToMode,
    dmSessionScope,
    blockStreamingEnabled,
    historyLimit,
    startupMs,
    startupGraceMs,
    dropPreStartupMessages,
    inboundDeduper,
    directTracker,
    getRoomInfo,
    getMemberDisplayName,
    resolveLiveUserAllowlist = resolveMatrixMonitorLiveUserAllowlist,
    resolveStorePath: resolveStorePathImpl = resolveStorePath,
    createChannelInboundEnvelopeBuilder:
      createChannelInboundEnvelopeBuilderImpl = createChannelInboundEnvelopeBuilder,
    channelInbound = core.channel.inbound,
    finalizeInboundContext,
    resolveHumanDelayConfig: resolveHumanDelayConfigImpl = resolveHumanDelayConfig,
  } = params;
  const handlerConfig: MatrixHandlerRuntimeConfig = {
    ...params,
    allowFromResolvedEntries,
    groupAllowFromResolvedEntries,
    configuredBotUserIds,
    resolveLiveUserAllowlist,
    resolveStorePath: resolveStorePathImpl,
    createChannelInboundEnvelopeBuilder: createChannelInboundEnvelopeBuilderImpl,
    resolveHumanDelayConfig: resolveHumanDelayConfigImpl,
  };
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "matrix",
    accountId,
  });
  const handlerState = createMatrixHandlerState({
    core,
    accountId,
    runtime,
    allowFromResolvedEntries,
    groupAllowFromResolvedEntries,
    resolveLiveUserAllowlist,
  });
  params.turnTakingCoordinator?.configureMonitorAccess(
    accountId,
    createMatrixReceiverAccessPreparer(handlerConfig, handlerState),
  );
  const resolveThreadContext = createMatrixThreadContextResolver({
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const resolveReplyContext = createMatrixReplyContextResolver({
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const roomHistoryTracker = createRoomHistoryTracker();
  const roomIngressQueue = new KeyedAsyncQueue();
  const sharedDmContextNoticeRooms = new Set<string>();
  const runTurnTakingPreflight = createMatrixTurnTakingPreflight(params);

  const runRoomIngress = async <T>(roomId: string, task: () => Promise<T>): Promise<T> => {
    return await roomIngressQueue.enqueue(roomId, task);
  };

  return async (roomId: string, incomingEvent: MatrixRawEvent) => {
    let event: MatrixRawEvent;
    let inboundEventKind: InboundEventKind;
    let inboundReplayClaim:
      | import("openclaw/plugin-sdk/persistent-dedupe").ChannelReplayClaimHandle
      | undefined;
    let draftControllerRef: Awaited<ReturnType<typeof createMatrixDraftController>> | undefined;
    let settleForegroundDraftPresentation: (() => Promise<void>) | undefined;
    let enhancedTurnTakingActive = false;
    let releaseTurnTakingIngress: (() => void) | undefined;
    let previewObservationId: string | undefined;
    let previewObservationOnly = false;
    try {
      const preflight = await runTurnTakingPreflight(roomId, incomingEvent);
      if (preflight.kind === "consume") {
        return;
      }
      event = preflight.event;
      inboundEventKind = preflight.inboundEventKind;
      releaseTurnTakingIngress = preflight.releaseIngress;
      previewObservationId = preflight.previewObservationId;
      previewObservationOnly = preflight.previewObservationOnly;
      const eventId = typeof event.event_id === "string" ? event.event_id.trim() : "";
      const eventType = event.type;

      const isPollEvent = isPollEventType(eventType);
      const isReactionEvent = eventType === EventType.Reaction;
      const locationContent = event.content as LocationMessageEventContent;
      const isLocationEvent =
        eventType === EventType.Location ||
        (eventType === EventType.RoomMessage && locationContent.msgtype === EventType.Location);
      if (
        eventType !== EventType.RoomMessage &&
        !isPollEvent &&
        !isLocationEvent &&
        !isReactionEvent
      ) {
        return;
      }
      logVerboseMessage(
        `matrix: inbound event room=${roomId} type=${eventType} id=${event.event_id ?? "unknown"}`,
      );
      const senderId = event.sender;
      if (!senderId) {
        return;
      }
      const eventTs = event.origin_server_ts;
      const eventAge = event.unsigned?.age;
      const commitInboundEventIfClaimed = async () => {
        const claim = inboundReplayClaim;
        if (!claim) {
          return;
        }
        await claim.commit();
        if (inboundReplayClaim === claim) {
          inboundReplayClaim = undefined;
        }
      };
      const readIngressPrefix = () =>
        readMatrixIngressPrefix({
          client,
          senderId,
          dropPreStartupMessages,
          eventTs: eventTs ?? undefined,
          eventAge: eventAge ?? undefined,
          startupMs,
          startupGraceMs,
          event,
          eventType,
          eventId,
          inboundDeduper,
          roomId,
          logVerboseMessage,
          directTracker,
          claimInboundReplay: (handle) => {
            inboundReplayClaim = handle;
          },
          skipInboundReplayClaim: previewObservationOnly,
        });
      const continueIngress = async (paramsLocal: MatrixIngressAccessParams) => {
        const access = await resolveMatrixIngressAccess({
          handler: handlerConfig,
          params: paramsLocal,
          roomId,
          event,
          eventTs: eventTs ?? undefined,
          senderId,
          isReactionEvent,
          readStoreAllowFrom: handlerState.readStoreAllowFrom,
          shouldSendPairingReply: handlerState.shouldSendPairingReply,
          resolveLiveAccountAllowlists: handlerState.resolveLiveAccountAllowlists,
          roomHistoryTracker,
          commitInboundEventIfClaimed,
        });
        if (!access) {
          return undefined;
        }
        if (previewObservationId && params.turnTakingCoordinator) {
          const authorized = await params.turnTakingCoordinator.authorizePreviewObservation({
            roomId,
            accountId,
            observationId: previewObservationId,
          });
          if (!authorized) {
            logVerboseMessage(
              `matrix: enhanced preview observation was no longer current room=${roomId} id=${previewObservationId}`,
            );
            await access.commitInboundEventIfClaimedAndDiscardReserved();
            return undefined;
          }
          if (previewObservationOnly) {
            await access.commitInboundEventIfClaimedAndDiscardReserved();
            return undefined;
          }
        }
        return await resolveMatrixIngressContent({
          handler: handlerConfig,
          params: paramsLocal,
          access,
          roomId,
          event,
          eventType,
          isPollEvent,
          eventTs: eventTs ?? undefined,
          senderId,
          roomHistoryTracker,
          commitInboundEventIfClaimed,
          turnTakingTransportSupported: preflight.turnTakingTransportSupported,
        });
      };
      const ingressResult =
        historyLimit > 0
          ? await runRoomIngress(roomId, async () => {
              const prefix = await readIngressPrefix();
              if (!prefix) {
                return undefined;
              }
              if (prefix.isDirectMessage) {
                return { deferredPrefix: prefix } as const;
              }
              const result = await continueIngress({
                ...prefix,
                audioPreflightMode: shouldDeferMatrixAudioPreflightForRoomIngress({
                  content: prefix.content,
                  cfg,
                })
                  ? "defer"
                  : "run",
              });
              return result && "deferredPrefix" in result
                ? { deferredPrefix: result.deferredPrefix }
                : { ingressResult: result };
            })
          : undefined;
      const resolvedIngressResult =
        historyLimit > 0
          ? ingressResult?.deferredPrefix
            ? await continueIngress(ingressResult.deferredPrefix)
            : ingressResult?.ingressResult
          : await (async () => {
              const prefix = await readIngressPrefix();
              if (!prefix) {
                return undefined;
              }
              return await continueIngress(prefix);
            })();
      if (!resolvedIngressResult) {
        return;
      }
      if ("deferredPrefix" in resolvedIngressResult) {
        return;
      }

      const {
        route: _route,
        hasExplicitSessionBinding,
        roomConfig,
        isDirectMessage,
        isRoom,
        shouldRequireMention,
        wasMentioned,
        effectiveWasMentioned,
        shouldBypassMention,
        canDetectMention,
        commandAuthorized,
        inboundHistory,
        senderName,
        bodyText,
        commandBodyText,
        media,
        preflightAudioTranscript,
        locationPayload,
        messageId,
        triggerSnapshot,
        threadRootId,
        thread,
        botLoopProtection,
        enhancedTurnTakingEligible,
        turnTakingBaselineSequence,
        turnTakingInitialActivePreviewResponseIds,
        effectiveGroupAllowFrom,
        effectiveRoomUsers,
        resolveMessageIngress,
        selfUserId,
      } = resolvedIngressResult;
      enhancedTurnTakingActive = enhancedTurnTakingEligible;
      const enhancedFreshnessGateEnabled =
        enhancedTurnTakingEligible &&
        turnTakingBaselineSequence !== undefined &&
        (params.turnTaking?.redraftDepth ?? 1) > 0;

      // Keep the per-room ingress gate focused on ordering-sensitive state updates.
      // Prompt/session enrichment below can run concurrently after the history snapshot is fixed.
      const inboundContext = await resolveMatrixInboundContext({
        resolveMessageIngress,
        client,
        core,
        cfg,
        accountId,
        runtime,
        logVerboseMessage,
        roomId,
        event,
        eventTs: eventTs ?? undefined,
        route: _route,
        isDirectMessage,
        isRoom,
        effectiveRoomUsers,
        groupPolicy,
        effectiveGroupAllowFrom,
        contextVisibilityMode,
        resolveThreadContext,
        resolveReplyContext,
        threadRootId,
        thread,
        getRoomInfo,
        senderId,
        senderName,
        bodyText,
        commandBodyText,
        roomConfig,
        messageId,
        inboundHistory,
        wasMentioned,
        effectiveWasMentioned,
        shouldBypassMention,
        canDetectMention,
        shouldRequireMention,
        commandAuthorized,
        inboundEventKind,
        locationPayload,
        media,
        preflightAudioTranscript,
        historyLimit,
        hasExplicitSessionBinding,
        dmSessionScope,
        sharedDmContextNoticeRooms,
        resolveStorePath: resolveStorePathImpl,
        createChannelInboundEnvelopeBuilder: createChannelInboundEnvelopeBuilderImpl,
        buildInboundContext: channelInbound.buildContext,
        finalizeInboundContext,
      });
      if (!inboundContext) {
        return;
      }
      const {
        replyToEventId,
        threadTarget,
        storePath,
        ctxPayload,
        replyTarget,
        sharedDmContextNotice,
      } = inboundContext;
      const replyRuntime = await createMatrixHandlerReplyRuntime({
        params,
        resolveHumanDelayConfig: resolveHumanDelayConfigImpl,
        route: _route,
        roomId,
        messageId,
        threadTarget,
        replyToEventId: replyToEventId ?? undefined,
        enhancedTurnTakingEligible,
        selfUserId,
      });
      const {
        draftController,
        draftStream,
        settleCurrentDraftPresentation,
        settleForegroundDraftPresentation: settleForegroundDraft,
        replyDispatcher,
        onModelSelected,
      } = replyRuntime;
      draftControllerRef = draftController;
      settleForegroundDraftPresentation = settleForegroundDraft;
      const { deliverReply, onReplyError, turnDispatcherOptions } = replyDispatcher;
      const pinnedMainDmOwner = isDirectMessage
        ? await (async () => {
            const { liveCfg, liveDmAllowFrom } = await handlerState.resolveLiveAccountAllowlists();
            return resolvePinnedMainDmOwnerFromAllowlist({
              dmScope: liveCfg.session?.dmScope,
              allowFrom: liveDmAllowFrom,
              normalizeEntry: normalizeMatrixUserId,
            });
          })()
        : null;

      const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
        route: _route,
        sessionKey: _route.sessionKey,
      });
      const replayClaimAtDispatch = inboundReplayClaim;
      // Active-run deferral outlives this handler. Transfer the exact replay claim to the
      // reply lane so adoption commits it and abandonment reopens it for Matrix replay.
      const turnAdoptionLifecycle = replayClaimAtDispatch
        ? {
            admission: "exclusive" as const,
            onDeferred: () => {
              if (inboundReplayClaim !== replayClaimAtDispatch) {
                return false;
              }
              inboundReplayClaim = undefined;
              return undefined;
            },
            onAdopted: async () => {
              if (inboundReplayClaim === replayClaimAtDispatch) {
                inboundReplayClaim = undefined;
              }
              await replayClaimAtDispatch.commit();
            },
            onAbandoned: () => {
              if (inboundReplayClaim === replayClaimAtDispatch) {
                inboundReplayClaim = undefined;
              }
              replayClaimAtDispatch.release();
            },
          }
        : undefined;

      const turnResultPromise = channelInbound.run({
        channel: "matrix",
        accountId: _route.accountId,
        raw: event,
        ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
        adapter: {
          ingest: () => ({
            id: messageId,
            rawText: bodyText,
            textForAgent: ctxPayload.BodyForAgent,
            textForCommands: ctxPayload.CommandBody,
            raw: event,
          }),
          resolveTurn: () => ({
            cfg,
            channel: "matrix",
            accountId: _route.accountId,
            route: { agentId: _route.agentId, sessionKey: _route.sessionKey },
            ctxPayload,
            botLoopProtection,
            record: {
              updateLastRoute: isDirectMessage
                ? {
                    sessionKey: inboundLastRouteSessionKey,
                    channel: "matrix",
                    to: `room:${roomId}`,
                    accountId: _route.accountId,
                    mainDmOwnerPin:
                      inboundLastRouteSessionKey === _route.mainSessionKey && pinnedMainDmOwner
                        ? {
                            ownerRecipient: pinnedMainDmOwner,
                            senderRecipient: normalizeMatrixUserId(senderId),
                            onSkip: ({
                              ownerRecipient,
                              senderRecipient,
                            }: {
                              ownerRecipient: string;
                              senderRecipient: string;
                            }) => {
                              logVerboseMessage(
                                `matrix: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                              );
                            },
                          }
                        : undefined,
                  }
                : undefined,
              onRecordError: (err) => {
                logger.warn("failed updating session meta", {
                  error: String(err),
                  storePath,
                  sessionKey: ctxPayload.SessionKey ?? _route.sessionKey,
                });
              },
            },
            afterRecord: async () => {
              if (
                sharedDmContextNotice &&
                markTrackedRoomIfFirst(sharedDmContextNoticeRooms, roomId)
              ) {
                try {
                  await client.sendMessage(roomId, {
                    msgtype: "m.notice",
                    body: sharedDmContextNotice,
                  });
                } catch (err) {
                  logVerboseMessage(
                    `matrix: failed sending shared DM session notice room=${roomId}: ${String(err)}`,
                  );
                }
              }
            },
            delivery: {
              observeMessageSent: true,
              deliver: deliverReply,
              onError: (err, info) => onReplyError(err, info as Parameters<typeof onReplyError>[1]),
            },
            dispatcherOptions: {
              ...turnDispatcherOptions,
              onSettled: () => draftController.cancelProgressDraft(),
            },
            replyOptions: (() => {
              const replyOptions: GetReplyOptions = {
                skillFilter: roomConfig?.skills,
                ...(enhancedTurnTakingEligible
                  ? {
                      // Enhanced finals are host-owned so every completed reply carries the
                      // authenticated protocol, including turns that later drain from the
                      // follow-up queue. Fence message-tool sends to this exact source
                      // room/account/thread at every redraft depth so an ordinary unmarked tool
                      // send cannot become the turn's only visible output.
                      sourceReplyDeliveryMode: "automatic" as const,
                    }
                  : {}),
                // Enhanced multi-agent rooms use one correlated preview lineage;
                // block streaming is therefore disabled for this turn only.
                disableBlockStreaming: enhancedTurnTakingEligible || !blockStreamingEnabled,
                onPartialReply: draftStream
                  ? (payload) => draftController.onPartialReply(payload.text ?? "")
                  : undefined,
                onBlockReplyQueued: draftStream
                  ? (payload, context) => {
                      if (payload.isCompactionNotice === true) {
                        return false;
                      }
                      draftController.queueDraftBlockBoundary(payload, context);
                      return false;
                    }
                  : undefined,
                // Reset draft boundary bookkeeping on assistant message
                // boundaries so post-tool blocks stream from a fresh
                // cumulative payload (payload.text resets upstream).
                onAssistantMessageStart: draftStream
                  ? () => {
                      draftController.resetDraftBlockOffsets();
                      draftController.resetPreviewToolProgress();
                      return false;
                    }
                  : undefined,
                onQueuedFollowupAdmitted: draftStream
                  ? enhancedTurnTakingEligible
                    ? async () => {
                        await settleForegroundDraftPresentation?.();
                        await draftController.resetDraftDeliveryState();
                      }
                    : draftController.resetDraftDeliveryState
                  : undefined,
                onQueuedFollowupSettled:
                  enhancedTurnTakingEligible && draftStream
                    ? settleCurrentDraftPresentation
                    : undefined,
                ...draftController.buildPreviewToolProgressReplyOptions(),
                onModelSelected,
              };
              if (!enhancedTurnTakingEligible) {
                return replyOptions;
              }
              return bindMatrixSourceFinalizationRequest({
                replyOptions,
                sourceContext: ctxPayload,
                onBeforeAgentFinalize:
                  enhancedFreshnessGateEnabled && params.turnTaking
                    ? params.turnTakingCoordinator?.createFreshnessGate({
                        cfg,
                        accountId,
                        agentId: _route.agentId,
                        roomId,
                        threadId: threadRootId,
                        selfUserId,
                        baselineSequence: turnTakingBaselineSequence,
                        triggerEventId: messageId,
                        triggerSenderId: senderId,
                        triggerRequest: bodyText,
                        initialActivePreviewResponseIds: turnTakingInitialActivePreviewResponseIds,
                        onDiscardAccepted: draftController.handleAcceptedDiscard,
                        config: params.turnTaking,
                        log: logVerboseMessage,
                      })
                    : undefined,
              });
            })(),
          }),
        },
      });
      let turnResult: Awaited<typeof turnResultPromise>;
      try {
        turnResult = await turnResultPromise;
      } catch (err) {
        if (extractErrorCode(err) !== SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE) {
          throw err;
        }
        try {
          const { sendMessageMatrix } = await loadMatrixSendModule();
          await sendMessageMatrix(roomId, RESTART_RECOVERY_TOMBSTONE_NOTICE, {
            cfg,
            client,
            accountId: _route.accountId,
            replyToId: threadTarget ?? (replyToMode === "off" ? undefined : messageId),
            threadId: threadTarget,
            deliveryQueueId: `matrix:restart-recovery-tombstone:${_route.accountId}:${roomId}:${eventId}`,
            deliveryPartIndex: 0,
            deliveryPartCount: 1,
            extraContent: { msgtype: "m.notice" },
          });
          await commitInboundEventIfClaimed();
        } catch (noticeError) {
          runtime.error?.(
            `matrix: failed completing restart-recovery tombstone notice room=${roomId} id=${eventId || "unknown"}: ${String(noticeError)}`,
          );
        }
        return;
      }
      if (!turnResult.dispatched) {
        if (
          turnResult.admission.kind === "drop" &&
          turnResult.admission.reason === "bot-loop-protection"
        ) {
          await commitInboundEventIfClaimed();
        }
        return;
      }
      const { dispatchResult } = turnResult;
      const { queuedFinal } = dispatchResult;
      if (replyDispatcher.finalReplyDeliveryFailed()) {
        logVerboseMessage(
          `matrix: final reply delivery failed room=${roomId} id=${messageId}; keeping replay committed`,
        );
        await commitInboundEventIfClaimed();
        return;
      }
      if (!queuedFinal && replyDispatcher.nonFinalReplyDeliveryFailed()) {
        logVerboseMessage(
          `matrix: non-final reply delivery failed room=${roomId} id=${messageId}; keeping replay committed`,
        );
        await commitInboundEventIfClaimed();
        return;
      }
      // Advance the per-agent watermark now that the reply succeeded (or no reply was needed).
      // Only advance to the snapshot position — messages added during async processing remain
      // visible for the next trigger.
      if (isRoom && triggerSnapshot) {
        roomHistoryTracker.consumeHistory(
          _route.agentId,
          roomId,
          triggerSnapshot,
          messageId,
          threadRootId ? thread.threadId : undefined,
        );
      }
      if (!hasFinalInboundReplyDispatch(dispatchResult)) {
        await commitInboundEventIfClaimed();
        return;
      }
      const finalCount = resolveInboundReplyDispatchCounts(dispatchResult).final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
      await commitInboundEventIfClaimed();
    } catch (err) {
      const draftController = draftControllerRef;
      if (
        draftController?.draftStream?.eventId() &&
        draftController.draftDisposition() === "active" &&
        !enhancedTurnTakingActive
      ) {
        // A Matrix-accepted preview is the only visible reply after an abort.
        draftController.markDraftRetained();
      }
      runtime.error?.(`matrix handler failed: ${String(err)}`);
    } finally {
      releaseTurnTakingIngress?.();
      // Stop the draft stream timer so partial drafts don't leak if the
      // model run throws or times out mid-stream.
      await settleForegroundDraftPresentation?.();
      inboundReplayClaim?.release();
    }
  };
}
