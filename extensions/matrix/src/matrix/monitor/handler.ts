import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createChannelInboundEnvelopeBuilder,
  hasFinalInboundReplyDispatch,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
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
import { resolveMatrixIngressAccess } from "./handler-ingress-access.js";
import { resolveMatrixIngressContent } from "./handler-ingress-content.js";
import { readMatrixIngressPrefix } from "./handler-ingress-prefix.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";
import { loadMatrixSendModule, redactMatrixDraftEvent } from "./handler-runtime.js";
import { createMatrixHandlerState } from "./handler-state.js";
import type { MatrixHandlerRuntimeConfig, MatrixMonitorHandlerParams } from "./handler-types.js";
import type { MatrixLocationPayload } from "./location.js";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import { createRoomHistoryTracker, type ReservedHistorySlot } from "./room-history.js";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  getAgentScopedMediaLocalRoots,
  logTypingFailure,
} from "./runtime-api.js";
import { createMatrixThreadContextResolver } from "./thread-context.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType } from "./types.js";

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
    streaming,
    previewToolProgressEnabled,
    blockStreamingEnabled,
    textLimit,
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

  const runRoomIngress = async <T>(roomId: string, task: () => Promise<T>): Promise<T> => {
    return await roomIngressQueue.enqueue(roomId, task);
  };

  return async (roomId: string, event: MatrixRawEvent) => {
    const eventId = typeof event.event_id === "string" ? event.event_id.trim() : "";
    let inboundReplayClaim:
      | import("openclaw/plugin-sdk/persistent-dedupe").ChannelReplayClaimHandle
      | undefined;
    let draftControllerRef: Awaited<ReturnType<typeof createMatrixDraftController>> | undefined;
    try {
      const eventType = event.type;
      if (eventType === EventType.RoomMessageEncrypted) {
        // Encrypted payloads are emitted separately after decryption.
        return;
      }

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
      if (event.unsigned?.redacted_because) {
        return;
      }
      const senderId = event.sender;
      if (!senderId) {
        return;
      }
      const eventTs = event.origin_server_ts;
      const eventAge = event.unsigned?.age;
      const commitInboundEventIfClaimed = async () => {
        if (!inboundReplayClaim) {
          return;
        }
        await inboundReplayClaim.commit();
        inboundReplayClaim = undefined;
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
        });
      const continueIngress = async (paramsLocal: {
        audioPreflightMode?: "defer" | "run";
        content: RoomMessageEventContent;
        isDirectMessage: boolean;
        locationPayload: MatrixLocationPayload | null;
        reservedHistorySlot?: ReservedHistorySlot;
        selfUserId: string;
      }) => {
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
        effectiveGroupAllowFrom,
        effectiveRoomUsers,
      } = resolvedIngressResult;

      // Keep the per-room ingress gate focused on ordering-sensitive state updates.
      // Prompt/session enrichment below can run concurrently after the history snapshot is fixed.
      const inboundContext = await resolveMatrixInboundContext({
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
        locationPayload,
        media,
        preflightAudioTranscript,
        historyLimit,
        hasExplicitSessionBinding,
        dmSessionScope,
        sharedDmContextNoticeRooms,
        resolveStorePath: resolveStorePathImpl,
        createChannelInboundEnvelopeBuilder: createChannelInboundEnvelopeBuilderImpl,
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
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: _route.accountId,
      });
      const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, _route.agentId);
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: _route.agentId,
        channel: "matrix",
        accountId: _route.accountId,
      });
      const typingCallbacks = createTypingCallbacks({
        start: async () => {
          const { sendTypingMatrix } = await loadMatrixSendModule();
          await sendTypingMatrix(roomId, true, undefined, client);
        },
        stop: async () => {
          const { sendTypingMatrix } = await loadMatrixSendModule();
          await sendTypingMatrix(roomId, false, undefined, client);
        },
        onStartError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "start",
            target: roomId,
            error: err,
          });
        },
        onStopError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "stop",
            target: roomId,
            error: err,
          });
        },
      });
      const draftController = await createMatrixDraftController({
        streaming,
        previewToolProgressEnabled,
        replyToMode,
        messageId,
        threadTarget,
        accountConfig: params.accountConfig,
        cfg,
        accountId: _route.accountId,
        roomId,
        client,
        logVerboseMessage,
      });
      const { draftStream } = draftController;
      draftControllerRef = draftController;
      const replyDispatcher = createMatrixReplyDispatcher({
        cfg,
        prefixOptions,
        humanDelay: resolveHumanDelayConfigImpl(cfg, _route.agentId),
        typingCallbacks,
        streaming,
        draftStream,
        draftController,
        client,
        roomId,
        runtime,
        textLimit,
        replyToMode,
        threadTarget,
        replyToEventId: replyToEventId ?? undefined,
        accountId: _route.accountId,
        mediaLocalRoots,
        tableMode,
        logVerboseMessage,
      });
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

      const turnResult = await core.channel.inbound.run({
        channel: "matrix",
        accountId: _route.accountId,
        raw: event,
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
              deliver: deliverReply,
              onError: (err, info) => onReplyError(err, info as Parameters<typeof onReplyError>[1]),
            },
            dispatcherOptions: {
              ...turnDispatcherOptions,
              onSettled: () => draftController.progressDraftGate.cancel(),
            },
            replyOptions: {
              skillFilter: roomConfig?.skills,
              // Preserve explicit block streaming with draft previews: drafts update the live
              // block, while block deliveries finalize completed blocks as separate events.
              disableBlockStreaming: !blockStreamingEnabled,
              onPartialReply: draftStream
                ? (payload) => draftController.onPartialReply(payload.text ?? "")
                : undefined,
              onBlockReplyQueued: draftStream
                ? (payload, context) => {
                    if (payload.isCompactionNotice === true) {
                      return;
                    }
                    draftController.queueDraftBlockBoundary(payload, context);
                  }
                : undefined,
              // Reset draft boundary bookkeeping on assistant message
              // boundaries so post-tool blocks stream from a fresh
              // cumulative payload (payload.text resets upstream).
              onAssistantMessageStart: draftStream
                ? () => {
                    draftController.resetDraftBlockOffsets();
                    draftController.resetPreviewToolProgress();
                  }
                : undefined,
              onQueuedFollowupAdmitted: draftStream
                ? draftController.resetDraftDeliveryState
                : undefined,
              ...draftController.buildPreviewToolProgressReplyOptions(),
              onModelSelected,
            },
          }),
        },
      });
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
      const { queuedFinal, counts } = dispatchResult;
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
      if (!hasFinalInboundReplyDispatch({ queuedFinal, counts })) {
        await commitInboundEventIfClaimed();
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
      await commitInboundEventIfClaimed();
    } catch (err) {
      runtime.error?.(`matrix handler failed: ${String(err)}`);
    } finally {
      // Stop the draft stream timer so partial drafts don't leak if the
      // model run throws or times out mid-stream.
      const draftStream = draftControllerRef?.draftStream;
      if (draftStream) {
        const draftEventId = await draftStream.stop().catch(() => undefined);
        if (draftEventId && draftControllerRef?.isDraftConsumed() !== true) {
          await redactMatrixDraftEvent(client, roomId, draftEventId);
        }
      }
      inboundReplayClaim?.release();
    }
  };
}
