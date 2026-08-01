import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  runChannelInboundEvent,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
// Telegram plugin module wires inbound turn execution to Telegram delivery controllers.
import {
  createChannelMessageReplyPipeline,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { isFastModeAutoProgressPayload } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramDeliveryController } from "./bot-message-dispatch-delivery.js";
import type { TelegramDraftController } from "./bot-message-dispatch-draft.js";
import type { TelegramProgressController } from "./bot-message-dispatch-progress.js";
import type { TelegramReplyDelivery } from "./bot-message-dispatch-reply.js";
import type { TelegramDispatchTurnState } from "./bot-message-dispatch.types.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { beginTelegramInboundEventDeliveryCorrelation } from "./inbound-event-delivery.js";

const TELEGRAM_MAX_CONSECUTIVE_TYPING_FAILURES = 5;

export async function runTelegramDispatchTurn(params: {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
  delivery: TelegramDeliveryController;
  draft: TelegramDraftController;
  /** Pre-adoption abort + lifecycle from durable ingress (optional for non-spooled). */
  turnAdoptionLifecycle?: {
    admission?: "exclusive" | "cancel-only";
    onAdopted: () => void | Promise<void>;
    onDeferred?: () => void;
    onAbandoned?: () => void;
    abortSignal?: AbortSignal;
  };
  isSuperseded: () => boolean;
  progress: TelegramProgressController;
  reply: TelegramReplyDelivery;
  state: TelegramDispatchTurnState;
  statusReactionController: TelegramMessageContext["statusReactionController"];
  streamMode: TelegramStreamMode;
  telegramCfg: TelegramAccountConfig;
  telegramDeps: TelegramBotDeps;
}) {
  const { context } = params;
  const isRoomEvent = context.ctxPayload.InboundEventKind === "room_event";
  const beginDeliveryCorrelation = () =>
    beginTelegramInboundEventDeliveryCorrelation(
      context.ctxPayload.SessionKey,
      {
        outboundTo: context.historyKey || String(context.chatId),
        outboundAccountId: context.route.accountId,
        markInboundEventDelivered: params.delivery.markDelivered,
      },
      { inboundEventKind: context.ctxPayload.InboundEventKind },
    );
  const endDeliveryCorrelation = beginDeliveryCorrelation();
  let splitReasoningOnNextStream = false;

  try {
    const { onModelSelected, ...replyPipeline } = (
      params.telegramDeps.createChannelMessageReplyPipeline ?? createChannelMessageReplyPipeline
    )({
      cfg: params.cfg,
      agentId: context.route.agentId,
      channel: "telegram",
      accountId: context.route.accountId,
      typing: {
        start: context.sendTyping,
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
        params.reply.onError(err, info as Parameters<typeof params.reply.onError>[1]),
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
        resolveTurn: () => ({
          cfg: params.cfg,
          channel: "telegram",
          accountId: context.route.accountId,
          route: {
            agentId: context.route.agentId,
            sessionKey: context.route.sessionKey,
          },
          ctxPayload: context.ctxPayload,
          record: context.turn.record,
          delivery: {
            deliver: async (payload, info) =>
              (await params.reply.deliver(payload, info)) as Awaited<
                ReturnType<ChannelInboundTurnPlan["delivery"]["deliver"]>
              >,
            // The shipped SDK declaration stays void; core still awaits the runtime promise.
            onError: handleDeliveryError as NonNullable<
              ChannelInboundTurnPlan["delivery"]["onError"]
            >,
          },
          dispatcherOptions: {
            ...replyPipeline,
            beforeDeliver: async (payload) => payload,
            onBeforeDeliverCancelled: params.reply.onBeforeDeliverCancelled,
            onSkip: params.reply.onSkip,
          },
          replyOptions: {
            skillFilter: context.skillFilter,
            disableBlockStreaming: params.draft.disableBlockStreaming,
            abortSignal: params.turnAdoptionLifecycle?.abortSignal,
            turnAdoptionLifecycle: params.turnAdoptionLifecycle
              ? {
                  admission: params.turnAdoptionLifecycle.admission ?? "exclusive",
                  onAdopted: params.turnAdoptionLifecycle.onAdopted,
                  onDeferred: params.turnAdoptionLifecycle.onDeferred,
                  onAbandoned: params.turnAdoptionLifecycle.onAbandoned,
                  abortSignal: params.turnAdoptionLifecycle.abortSignal,
                }
              : undefined,
            sourceReplyDeliveryMode: isRoomEvent ? "message_tool_only" : undefined,
            queuedDeliveryCorrelations: isRoomEvent
              ? [{ begin: beginDeliveryCorrelation }]
              : undefined,
            suppressTyping: isRoomEvent,
            onPartialReply:
              params.draft.answerLane.stream || params.draft.reasoningLane.stream
                ? (payload) =>
                    params.draft.enqueueEvent(async () => {
                      await params.draft.ingestDraftLaneSegments(payload);
                    })
                : undefined,
            onBlockReplyQueued: params.draft.answerLane.stream
              ? (payload, blockContext) =>
                  params.draft.enqueueEvent(async () => {
                    await params.draft.prepareQueuedAnswerBlock(payload, blockContext);
                  })
              : undefined,
            onReasoningStream: params.draft.reasoningLane.stream
              ? (payload) =>
                  params.draft.enqueueEvent(async () => {
                    if (splitReasoningOnNextStream) {
                      params.draft.repositionLaneForNewMessage(params.draft.reasoningLane);
                      splitReasoningOnNextStream = false;
                    }
                    await params.draft.ingestDraftLaneSegments(payload, true);
                  })
              : params.draft.streamReasoningInProgressDraft
                ? (payload) =>
                    params.draft.enqueueEvent(async () => {
                      await params.progress.pushReasoningProgress(payload);
                    })
                : undefined,
            onReasoningProgress: params.draft.answerLane.stream
              ? (payload) =>
                  params.draft.enqueueEvent(async () => {
                    await params.progress.pushThinkingTokenProgress(payload.progressTokens);
                  })
              : undefined,
            onAssistantMessageStart: params.draft.answerLane.stream
              ? () =>
                  params.draft.enqueueEvent(async () => {
                    params.reply.reasoningStepState.resetForNextStep();
                    params.progress.setFinalAnswerDelivered(false);
                    if (params.streamMode !== "progress") {
                      params.progress.reset();
                    }
                    if (params.draft.answerLane.finalized) {
                      await params.draft.rotateLaneForNewMessage(params.draft.answerLane);
                      params.draft.setRotateWhenQueuedBlocksSettle(false);
                    } else if (
                      params.draft.answerLane.hasStreamedMessage &&
                      !params.draft.isAnswerToolProgressOnly()
                    ) {
                      params.draft.setRotateWhenQueuedBlocksSettle(true);
                    }
                  })
              : undefined,
            onReasoningEnd: params.draft.reasoningLane.stream
              ? () =>
                  params.draft.enqueueEvent(async () => {
                    params.progress.closeReasoningBurst();
                    splitReasoningOnNextStream = params.draft.reasoningLane.hasStreamedMessage;
                    params.progress.reset();
                  })
              : () => params.progress.closeReasoningBurst(),
            suppressDefaultToolProgressMessages:
              !params.draft.streamDeliveryEnabled || Boolean(params.draft.answerLane.stream),
            forceToolResultProgress:
              params.streamMode === "progress" &&
              resolveChannelStreamingPreviewToolProgress(params.telegramCfg),
            allowProgressCallbacksWhenSourceDeliverySuppressed:
              !isRoomEvent && Boolean(params.draft.answerLane.stream),
            onVerboseProgressVisibility: (isActive) => {
              params.progress.setVerboseProgressActive(isActive);
            },
            commentaryProgressEnabled:
              params.streamMode === "progress"
                ? params.progress.commentaryProgressEnabled
                : undefined,
            progressPreambleEnabled: params.progress.progressPreambleEnabled,
            reasoningPayloadsEnabled: params.draft.durableReasoningPayloadsEnabled,
            onToolStart: params.progress.handleToolStart,
            onItemEvent: params.progress.handleItemEvent,
            onPlanUpdate: params.progress.handlePlanUpdate,
            onApprovalEvent: params.progress.handleApprovalEvent,
            onToolResult: async (payload) => {
              const text = payload.text?.trim();
              if (!text) {
                return;
              }
              const updatedDraft = await params.progress.pushToolProgress(text, {
                startImmediately: true,
              });
              if (
                !updatedDraft &&
                isFastModeAutoProgressPayload(payload) &&
                !params.progress.canPushToolProgress()
              ) {
                await params.delivery.sendPayload(payload);
              }
            },
            onCommandOutput: params.progress.handleCommandOutput,
            onPatchSummary: params.progress.handlePatchSummary,
            onCompactionStart: params.statusReactionController
              ? async () => {
                  await params.statusReactionController?.setCompacting();
                }
              : undefined,
            onCompactionEnd: params.statusReactionController
              ? async () => {
                  params.statusReactionController?.cancelPending();
                  await params.statusReactionController?.setThinking();
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
    params.state.queuedFinal = turnResult.dispatchResult.queuedFinal;
    if (turnResult.dispatchResult.attemptedVisibleFinalDelivery === true) {
      params.state.attemptedVisibleFinalDelivery = true;
    }
    if ((turnResult.dispatchResult.counts?.final ?? 0) > 0) {
      params.progress.markSawFinal();
    }
    params.state.suppressSilentReplyFallback =
      turnResult.dispatchResult.sourceReplyDeliveryMode === "message_tool_only";
    return true;
  } finally {
    endDeliveryCorrelation();
  }
}
