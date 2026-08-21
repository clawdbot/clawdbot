import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  readAgentRunTerminalOutcome,
  hasFinalInboundReplyDispatch,
  runChannelInboundEvent,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-outbound";
import { isFastModeAutoProgressPayload } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sendPayload } from "./bot-message-dispatch-delivery.js";
import {
  beginDraftQueuedFollowup,
  cleanupDrafts,
  enqueueDraftEvent,
  ingestDraftLaneSegments,
  prepareQueuedAnswerBlock,
  repositionLaneForNewMessage,
  rotateLaneForNewMessage,
  waitForDraftEvents,
} from "./bot-message-dispatch-draft.js";
import {
  canPushToolProgress,
  handleApprovalEvent,
  handleCommandOutput,
  handleItemEvent,
  handlePatchSummary,
  handlePlanUpdate,
  handleToolStart,
  pushReasoningProgress,
  pushThinkingTokenProgress,
  pushToolProgress,
} from "./bot-message-dispatch-progress.js";
import {
  deliverReply,
  handleBeforeDeliverCancelled,
  handleReplyError,
  handleReplySkip,
  resetReasoningStepState,
} from "./bot-message-dispatch-reply.js";
import type { TelegramDispatchTurn as Turn } from "./bot-message-dispatch.types.js";
import { TELEGRAM_CHAT_ACTION_INTERVAL_MS } from "./chat-action-timing.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

const TELEGRAM_MAX_CONSECUTIVE_TYPING_FAILURES = 5;

export async function runTelegramDispatchTurn(turn: Turn) {
  const { context } = turn;
  const isRoomEvent = context.ctxPayload.InboundEventKind === "room_event";
  const toolProgressEnabled =
    turn.streamMode !== "off" &&
    resolveChannelStreamingPreviewToolProgress(turn.telegramCfg, true, turn.streamMode);
  const beginDeliveryCorrelation = () =>
    telegramInboundEventDelivery.begin(
      context.ctxPayload.SessionKey,
      {
        outboundTo: context.historyKey || String(context.chatId),
        outboundAccountId: context.route.accountId,
        markInboundEventDelivered: turn.deliveryState.markDelivered,
      },
      { inboundEventKind: context.ctxPayload.InboundEventKind },
    );
  const endDeliveryCorrelation = beginDeliveryCorrelation();

  try {
    const { onModelSelected, ...replyPipeline } = (
      turn.telegramDeps.createChannelMessageReplyPipeline ?? createChannelMessageReplyPipeline
    )({
      cfg: turn.cfg,
      agentId: context.route.agentId,
      channel: "telegram",
      accountId: context.route.accountId,
      typing: {
        start: context.sendTyping,
        keepaliveIntervalMs: TELEGRAM_CHAT_ACTION_INTERVAL_MS,
        // ReplyOperation owns terminal cleanup; a per-inbound TTL would kill
        // feedback while the same long-running task is still active.
        maxDurationMs: 0,
        maxConsecutiveFailures: TELEGRAM_MAX_CONSECUTIVE_TYPING_FAILURES,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(context.chatId),
            error: err,
          });
        },
      },
    });
    const handleDeliveryError = async (err: unknown, info: { kind: string }) => {
      await Promise.resolve(
        handleReplyError(turn, err, info as Parameters<typeof handleReplyError>[2]),
      ).catch((callbackError: unknown) => {
        logVerbose(`telegram reply error callback failed: ${String(callbackError)}`);
      });
    };
    const turnResult = await runChannelInboundEvent({
      channel: "telegram",
      accountId: context.route.accountId,
      raw: context,
      adapter: {
        ingest: () => ({
          id: context.ctxPayload.MessageSid ?? `${context.chatId}:${Date.now()}`,
          timestamp:
            typeof context.ctxPayload.Timestamp === "number"
              ? context.ctxPayload.Timestamp
              : undefined,
          rawText: context.ctxPayload.RawBody ?? "",
          textForAgent: context.ctxPayload.BodyForAgent,
          textForCommands: context.ctxPayload.CommandBody,
          raw: context,
        }),
        resolveTurn: (): ChannelInboundTurnPlan<"provider_message_sending"> => ({
          cfg: turn.cfg,
          channel: "telegram",
          accountId: context.route.accountId,
          route: {
            agentId: context.route.agentId,
            sessionKey: context.route.sessionKey,
          },
          ctxPayload: context.ctxPayload,
          record: context.turn.record,
          delivery: {
            deliverWithProviderMessageSending: async (payload, info) =>
              await deliverReply(turn, payload, info),
            // The shipped SDK declaration stays void; core still awaits the runtime promise.
            onError: handleDeliveryError as NonNullable<
              ChannelInboundTurnPlan["delivery"]["onError"]
            >,
          },
          dispatcherOptions: {
            ...replyPipeline,
            beforeDeliver: async (payload) => payload,
            onBeforeDeliverCancelled: (payload, info) =>
              handleBeforeDeliverCancelled(turn, payload, info),
            onSkip: (payload, info) => handleReplySkip(turn, payload, info),
          },
          replyOptions: {
            skillFilter: context.skillFilter,
            disableBlockStreaming: turn.disableBlockStreaming,
            abortSignal: turn.turnAdoptionLifecycle?.abortSignal,
            turnAdoptionLifecycle: turn.turnAdoptionLifecycle
              ? {
                  admission: turn.turnAdoptionLifecycle.admission ?? "exclusive",
                  onAdopted: turn.turnAdoptionLifecycle.onAdopted,
                  onDeferred: turn.turnAdoptionLifecycle.onDeferred,
                  onAbandoned: turn.turnAdoptionLifecycle.onAbandoned,
                  abortSignal: turn.turnAdoptionLifecycle.abortSignal,
                }
              : undefined,
            sourceReplyDeliveryMode: isRoomEvent ? "message_tool_only" : undefined,
            queuedDeliveryCorrelations: isRoomEvent
              ? [{ begin: beginDeliveryCorrelation }]
              : undefined,
            suppressTyping: isRoomEvent,
            onPartialReply:
              turn.answerLane.stream || turn.reasoningLane.stream
                ? (payload) => {
                    const queued = enqueueDraftEvent(turn, async () => {
                      await ingestDraftLaneSegments(turn, payload);
                    });
                    // Queue settlement records draft intent; a numeric provider message ID
                    // proves operator visibility for terminal recovery.
                    return queued.then(async () => {
                      const answerStream = turn.answerLane.stream;
                      await answerStream?.waitForInFlight();
                      const providerMessageId = answerStream?.messageId();
                      return (
                        typeof providerMessageId === "number" && Number.isFinite(providerMessageId)
                      );
                    });
                  }
                : undefined,
            onBlockReplyQueued: turn.answerLane.stream
              ? (payload, blockContext) => {
                  const queued = enqueueDraftEvent(turn, async () => {
                    await prepareQueuedAnswerBlock(turn, payload, blockContext);
                  });
                  return queued.then(() => false);
                }
              : undefined,
            onReasoningStream: turn.reasoningLane.stream
              ? (payload) => {
                  const queued = enqueueDraftEvent(turn, async () => {
                    if (turn.splitReasoningOnNextStream) {
                      repositionLaneForNewMessage(turn, turn.reasoningLane);
                      turn.splitReasoningOnNextStream = false;
                    }
                    await ingestDraftLaneSegments(turn, payload, true);
                  });
                  return queued.then(() => false);
                }
              : turn.streamReasoningInProgressDraft
                ? (payload) => {
                    const queued = enqueueDraftEvent(turn, async () => {
                      await pushReasoningProgress(turn, payload);
                    });
                    return queued.then(() => false);
                  }
                : undefined,
            onReasoningProgress: turn.answerLane.stream
              ? (payload) =>
                  enqueueDraftEvent(turn, async () => {
                    await pushThinkingTokenProgress(turn, payload.progressTokens);
                  })
              : undefined,
            onAssistantMessageStart: turn.answerLane.stream
              ? () => {
                  const queued = enqueueDraftEvent(turn, async () => {
                    resetReasoningStepState(turn);
                    turn.finalAnswerDelivered = false;
                    if (turn.streamMode !== "progress") {
                      turn.progressCompositor.reset();
                    }
                    if (turn.answerLane.finalized) {
                      await rotateLaneForNewMessage(turn, turn.answerLane);
                      turn.rotateAnswerLaneWhenQueuedBlocksSettle = false;
                    } else if (
                      turn.answerLane.hasStreamedMessage &&
                      !turn.activeAnswerDraftIsToolProgressOnly
                    ) {
                      turn.rotateAnswerLaneWhenQueuedBlocksSettle = true;
                    }
                  });
                  return queued.then(() => false);
                }
              : undefined,
            onReasoningEnd: turn.reasoningLane.stream
              ? () => {
                  const queued = enqueueDraftEvent(turn, async () => {
                    turn.splitReasoningOnNextStream = turn.reasoningLane.hasStreamedMessage;
                    turn.progressCompositor.reset();
                  });
                  return queued.then(() => false);
                }
              : () => false,
            onQueuedFollowupAdmitted: () => {
              beginDraftQueuedFollowup(turn);
              turn.finalAnswerDeliveryStarted = false;
              turn.finalAnswerDelivered = false;
              turn.progressCompositor.beginNewTurn({ force: true });
            },
            onQueuedFollowupSettled: async () => {
              turn.progressCompositor.cancel();
              await waitForDraftEvents(turn);
              await cleanupDrafts(turn, turn.isSuperseded());
            },
            suppressDefaultToolProgressMessages:
              !turn.streamDeliveryEnabled || Boolean(turn.answerLane.stream),
            suppressToolProgressMessages: !toolProgressEnabled,
            forceToolResultProgress:
              Boolean(turn.answerLane.stream) &&
              turn.streamMode === "progress" &&
              toolProgressEnabled,
            allowProgressCallbacksWhenSourceDeliverySuppressed:
              !isRoomEvent && Boolean(turn.answerLane.stream),
            onVerboseProgressVisibility: (isActive) => {
              turn.verboseProgressActive = isActive;
            },
            commentaryProgressEnabled:
              turn.streamMode === "progress" ? turn.commentaryProgressEnabled : undefined,
            progressPreambleEnabled: turn.progressPreambleEnabled,
            commentaryPayloadsEnabled: turn.progressPreambleEnabled,
            reasoningPayloadsEnabled: turn.durableReasoningPayloadsEnabled,
            onToolStart: (payload) => handleToolStart(turn, payload),
            onItemEvent: (payload) => handleItemEvent(turn, payload),
            onPlanUpdate: (payload) => handlePlanUpdate(turn, payload),
            onApprovalEvent: (payload) => handleApprovalEvent(turn, payload),
            onToolResult: async (payload) => {
              const text = payload.text?.trim();
              if (!text) {
                return false;
              }
              const updatedDraft = await pushToolProgress(turn, text, {
                startImmediately: true,
              });
              if (updatedDraft) {
                return true;
              }
              if (isFastModeAutoProgressPayload(payload) && !canPushToolProgress(turn)) {
                await sendPayload(turn, payload);
                return true;
              }
              return false;
            },
            onCommandOutput: (payload) => handleCommandOutput(turn, payload),
            onPatchSummary: (payload) => handlePatchSummary(turn, payload),
            onCompactionStart: turn.statusReactionController
              ? async () => {
                  await turn.statusReactionController?.setCompacting();
                  return false;
                }
              : undefined,
            onCompactionEnd: turn.statusReactionController
              ? async () => {
                  turn.statusReactionController?.cancelPending();
                  await turn.statusReactionController?.setThinking();
                  return false;
                }
              : undefined,
            onModelSelected,
          },
        }),
      },
    });
    if (!turnResult.dispatched) {
      return false;
    }
    turn.queuedFinal ||= hasFinalInboundReplyDispatch(turnResult.dispatchResult);
    turn.agentRunFailed = readAgentRunTerminalOutcome(turnResult.dispatchResult) === "failed";
    turn.noVisibleReplyFallbackEligible =
      turnResult.dispatchResult.noVisibleReplyFallbackEligible === true;
    turn.suppressSilentReplyFallback =
      turnResult.dispatchResult.sourceReplyDeliveryMode === "message_tool_only";
    return true;
  } finally {
    endDeliveryCorrelation();
  }
}
