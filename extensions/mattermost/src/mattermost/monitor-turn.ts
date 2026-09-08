// Mattermost plugin module owns one accepted message's reply turn and delivery.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  isChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  buildChannelProgressDraftLineForEntry,
  createMessageReceiptFromOutboundResults,
  createChannelProgressDraftCompositor,
  listMessageReceiptPlatformIds,
} from "openclaw/plugin-sdk/channel-outbound";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import type { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import type { MattermostPost } from "./client.js";
import {
  createMattermostDraftPreviewBoundaryController,
  createMattermostDraftStream,
} from "./draft-stream.js";
import { normalizeMattermostAllowEntry } from "./ingress-identity.js";
import {
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostReplyRootId,
  shouldSuppressMattermostDefaultToolProgressMessages,
  shouldUpdateMattermostDraftToolProgress,
} from "./monitor-context.js";
import {
  deliverMattermostReplyWithDraftPreview,
  type MattermostPreviewFinalResolution,
  type MattermostDraftPreviewState,
} from "./monitor-draft-delivery.js";
import type { MattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostIngressLifecycle } from "./monitor-ingress.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { deliverMattermostReplyPayload, joinMattermostVisibleContent } from "./reply-delivery.js";
import type { HistoryEntry, ReplyPayload } from "./runtime-api.js";
import { createChannelMessageReplyPipeline } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import { recordMattermostThreadParticipation } from "./thread-participation.js";

type MattermostInboundTurnParams = {
  post: MattermostPost;
  rawText: string;
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  eventPlan: MattermostEventPlan;
  historyKey: string | null;
  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  pinnedMainDmOwner: string | null;
  turnAdoptionLifecycle?: MattermostIngressLifecycle;
};

function createDisabledMattermostDraftStream(): ReturnType<typeof createMattermostDraftStream> {
  const noopAsync = async () => {};
  return {
    update: () => {},
    updateAssistantText: () => {},
    flush: noopAsync,
    postId: () => undefined,
    clear: noopAsync,
    deleteCurrentMessage: noopAsync,
    discardPending: noopAsync,
    seal: noopAsync,
    stop: noopAsync,
    forceNewMessage: noopAsync,
    settleBoundaries: noopAsync,
    resolveFinalText: (text) => ({ kind: "full", text, publishedParts: [] }),
  };
}

export async function dispatchMattermostInboundTurn(
  monitor: MattermostMonitorContext,
  params: MattermostInboundTurnParams,
): Promise<void> {
  const { account, cfg, client, core, runtime } = monitor;
  const {
    channelHistories,
    ctxPayload,
    eventPlan,
    historyKey,
    historyLimit,
    pinnedMainDmOwner,
    post,
    rawText,
    turnAdoptionLifecycle,
  } = params;
  const { channelId, kind, route, senderId, thread, to } = eventPlan;
  const { effectiveReplyToId } = thread;
  const {
    replyOptions,
    replyPipeline: baseReplyPipeline,
    tableMode,
    textLimit,
  } = eventPlan.createReplyPlan();
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "mattermost", account.accountId);
  const { onModelSelected, typingCallbacks, resolveResponsePrefix, ...dispatcherPipeline } =
    createChannelMessageReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: "mattermost",
      accountId: account.accountId,
      typing: baseReplyPipeline.typing,
    });
  // Provider drafts are visible before outbound modifiers run. Keep them off whenever a hook
  // can rewrite or cancel so the original payload cannot escape the durable delivery gate.
  const hookRunner = getGlobalHookRunner();
  const allowProviderPreview = !(
    (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
    (hookRunner?.hasHooks("message_sending") ?? false)
  );
  const draftPreviewEnabled = allowProviderPreview && account.streamingMode !== "off";
  const draftProgressEnabled =
    draftPreviewEnabled &&
    (account.streamingMode === "progress" || shouldUpdateMattermostDraftToolProgress(account));
  const suppressDefaultToolProgressMessages =
    draftPreviewEnabled && shouldSuppressMattermostDefaultToolProgressMessages(account);
  const draftStream = draftPreviewEnabled
    ? createMattermostDraftStream({
        client,
        channelId,
        rootId: effectiveReplyToId,
        throttleMs: 1200,
        chunkText: (value) =>
          core.channel.text.chunkMarkdownTextWithMode(
            core.channel.text.convertMarkdownTables(value, tableMode),
            textLimit,
            chunkMode,
          ),
        log: monitor.logVerboseMessage,
        warn: monitor.logVerboseMessage,
      })
    : createDisabledMattermostDraftStream();
  const previewBoundaryController = createMattermostDraftPreviewBoundaryController({
    enabled: draftPreviewEnabled && account.streamingMode === "block",
    forceNewMessage: async () => {
      await draftStream.forceNewMessage();
    },
  });
  let lastPartialText = "";
  let firstAssistantPreviewPrefix: string | undefined;
  let firstAssistantPreviewPrefixPending = true;
  let currentAssistantPreviewUsesPrefix = false;
  let blockPreviewActivity: "none" | "reasoning" | "text" | "tool" = "none";
  let blockPreviewAssistantMessagePending = false;
  const progressDraft = createChannelProgressDraftCompositor({
    entry: account.config,
    mode: account.streamingMode,
    active: draftPreviewEnabled,
    seed: `${account.accountId}:${channelId}`,
    shouldStartNow: (line) => typeof line === "object" && line.kind === "item",
    update: async (previewText, options) => {
      draftStream.update(previewText);
      if (options?.flush) {
        await draftStream.flush();
      }
    },
    deleteCurrent: () => draftStream.deleteCurrentMessage(),
  });
  const enterBlockPreviewActivity = (activity: "reasoning" | "text" | "tool") => {
    if (account.streamingMode !== "block") {
      return undefined;
    }
    const continuingToolActivity = activity === "tool" && blockPreviewActivity === "tool";
    const continuingTextActivity =
      activity === "text" &&
      blockPreviewActivity === "text" &&
      !blockPreviewAssistantMessagePending;
    const continuingReasoningActivity =
      activity === "reasoning" && blockPreviewActivity === "reasoning";
    const continuesCurrentActivity =
      continuingToolActivity || continuingTextActivity || continuingReasoningActivity;
    // Reasoning placeholders are transient: a visible successor reuses them, while entering from durable text/tool rotates generations.
    const startsNewGeneration = !continuesCurrentActivity && blockPreviewActivity !== "reasoning";
    if (startsNewGeneration) {
      currentAssistantPreviewUsesPrefix = false;
    }
    const boundarySettled = startsNewGeneration
      ? previewBoundaryController.noteBoundary()
      : undefined;
    // Message-start is only a candidate boundary: consecutive tools stay together, while the first visible text or reasoning starts a new block.
    if (!continuesCurrentActivity) {
      progressDraft.resetActivity();
    }
    blockPreviewActivity = activity;
    blockPreviewAssistantMessagePending = false;
    if (activity === "tool") {
      lastPartialText = "";
    }
    return boundarySettled;
  };
  const previewState: MattermostDraftPreviewState = { finalizedViaPreviewPost: false };

  const resolvePreviewFinalText = (text?: string): MattermostPreviewFinalResolution | undefined => {
    const resolution = draftStream.resolveFinalText(typeof text === "string" ? text : "");
    const confirmedDelivery =
      resolution.publishedParts.length > 0
        ? (() => {
            const receipt = createMessageReceiptFromOutboundResults({
              results: resolution.publishedParts.map((part) => ({
                channel: "mattermost",
                messageId: part.messageId,
                channelId,
              })),
              kind: "preview",
              ...(effectiveReplyToId ? { replyToId: effectiveReplyToId } : {}),
            });
            return {
              outcome: "text" as const,
              messageIds: listMessageReceiptPlatformIds(receipt),
              receipt,
              visibleReplySent: true,
              content: joinMattermostVisibleContent(
                resolution.publishedParts.map((part) => part.content),
              ),
            };
          })()
        : undefined;
    const deliveryText = resolution.kind === "already-delivered" ? "" : resolution.text;
    const formatted = core.channel.text.convertMarkdownTables(deliveryText, tableMode);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(formatted, textLimit, chunkMode);
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    if (chunks.length !== 1) {
      return {
        deliveryText,
        confirmedDelivery,
        alreadyDelivered: resolution.kind === "already-delivered",
      };
    }
    const trimmed = chunks[0]?.trim();
    if (!trimmed) {
      return {
        deliveryText,
        confirmedDelivery,
        alreadyDelivered: resolution.kind === "already-delivered",
      };
    }
    if (
      lastPartialText &&
      lastPartialText.startsWith(trimmed) &&
      trimmed.length < lastPartialText.length
    ) {
      return { deliveryText, confirmedDelivery, alreadyDelivered: false };
    }
    return {
      editText: trimmed,
      deliveryText,
      confirmedDelivery,
      alreadyDelivered: false,
    };
  };

  const updateDraftFromPartial = (text?: string) => {
    const cleaned = text?.trim();
    if (!cleaned || cleaned === lastPartialText) {
      return undefined;
    }
    if (
      lastPartialText &&
      lastPartialText.startsWith(cleaned) &&
      cleaned.length < lastPartialText.length
    ) {
      return undefined;
    }
    const boundarySettled = enterBlockPreviewActivity("text");
    progressDraft.resetActivity({ suppressed: true });
    lastPartialText = cleaned;
    if (firstAssistantPreviewPrefixPending) {
      firstAssistantPreviewPrefix = resolveResponsePrefix?.();
      firstAssistantPreviewPrefixPending = false;
      currentAssistantPreviewUsesPrefix = Boolean(firstAssistantPreviewPrefix);
    }
    const previewText =
      currentAssistantPreviewUsesPrefix && firstAssistantPreviewPrefix
        ? cleaned.startsWith(firstAssistantPreviewPrefix)
          ? cleaned
          : `${firstAssistantPreviewPrefix} ${cleaned}`
        : cleaned;
    draftStream.updateAssistantText(previewText);
    previewBoundaryController.noteUpdate();
    return boundarySettled;
  };

  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    ...dispatcherPipeline,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    typingCallbacks,
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    observeMessageSent: true,
    deliver: async (payloadEntry: ReplyPayload, info) => {
      if (info.kind === "final") {
        await enterBlockPreviewActivity("text");
        // Final text uses only confirmed-visible generations, so join prior boundary work before deciding whether to edit in place.
        await draftStream.settleBoundaries();
        progressDraft.markFinalReplyStarted();
      }
      // A visible same-thread final can be a send or an in-place draft edit; either path records participation.
      let threadParticipationRecorded = false;
      const markThreadParticipation = () => {
        if (!threadParticipationRecorded && kind !== "direct" && effectiveReplyToId) {
          threadParticipationRecorded = true;
          recordMattermostThreadParticipation(account.accountId, channelId, effectiveReplyToId, {
            agentId: route.agentId,
          });
        }
      };
      const result = await deliverMattermostReplyWithDraftPreview({
        payload: payloadEntry,
        info,
        kind,
        client,
        draftStream,
        effectiveReplyToId,
        resolvePreviewFinalText,
        previewState,
        logVerboseMessage: monitor.logVerboseMessage,
        recordThreadParticipation: markThreadParticipation,
        deliverPayload: async (payloadToDeliver) => {
          const finalTextResolution =
            info.kind === "final" &&
            !payloadToDeliver.isError &&
            typeof payloadToDeliver.text === "string"
              ? draftStream.resolveFinalText(payloadToDeliver.text)
              : undefined;
          const resolvedPayload = finalTextResolution
            ? {
                ...payloadToDeliver,
                text:
                  finalTextResolution.kind === "already-delivered" ? "" : finalTextResolution.text,
              }
            : payloadToDeliver;
          const deliveryResult = await deliverMattermostReplyPayload({
            core,
            cfg,
            payload: resolvedPayload,
            channelId,
            accountId: account.accountId,
            agentId: route.agentId,
            replyToId: resolveMattermostReplyRootId({
              kind,
              threadRootId: effectiveReplyToId,
              replyToId: payloadToDeliver.replyToId,
            }),
            textLimit,
            tableMode,
            sendMessage: sendMessageMattermost,
          }).catch((error: unknown) => {
            if (isChannelPartialDeliveryError(error)) {
              markThreadParticipation();
            }
            throw error;
          });
          // Record only visible sends so reasoning-only, empty, or suppressed threads do not auto-engage later.
          if (deliveryResult.outcome === "text" || deliveryResult.outcome === "media") {
            markThreadParticipation();
          } else if (
            deliveryResult.outcome === "empty" &&
            finalTextResolution?.kind === "already-delivered"
          ) {
            // The terminal payload confirms the already-published assistant block as
            // the visible final reply even though this delivery has no remaining text.
            markThreadParticipation();
          }
          const deliveryLog = formatMattermostFinalDeliveryOutcomeLog({
            outcome: deliveryResult.outcome,
            payload: resolvedPayload,
            to,
            accountId: account.accountId,
            agentId: route.agentId,
          });
          if (deliveryLog) {
            runtime.log?.(deliveryLog);
          }
          return deliveryResult;
        },
      }).catch((error: unknown) => {
        if (isChannelPartialDeliveryError(error)) {
          markThreadParticipation();
          if (info.kind === "final") {
            // The provider final is already visible even though later bookkeeping failed.
            // Settle progress before rethrowing so late callbacks cannot revive stale draft state.
            progressDraft.markFinalReplyDelivered();
          }
        }
        throw error;
      });
      if (result.visibleReplySent) {
        markThreadParticipation();
      }
      if (info.kind === "final") {
        progressDraft.markFinalReplyDelivered();
      }
      return result;
    },
    onError: (err, info) => {
      runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
    },
  };
  const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route,
    sessionKey: route.sessionKey,
  });

  try {
    await core.channel.inbound.run({
      channel: "mattermost",
      accountId: route.accountId,
      raw: post,
      adapter: {
        ingest: () => ({
          id: post.id ?? `${to}:${Date.now()}`,
          timestamp: post.create_at ?? undefined,
          rawText,
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: post,
        }),
        resolveTurn: () => ({
          cfg,
          channel: "mattermost",
          accountId: route.accountId,
          route: {
            agentId: route.agentId,
            dmScope: route.dmScope,
            sessionKey: route.sessionKey,
          },
          ctxPayload,
          record: {
            updateLastRoute:
              kind === "direct"
                ? {
                    sessionKey: inboundLastRouteSessionKey,
                    channel: "mattermost",
                    to,
                    accountId: route.accountId,
                    mainDmOwnerPin:
                      inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner
                        ? {
                            ownerRecipient: pinnedMainDmOwner,
                            senderRecipient: normalizeMattermostAllowEntry(senderId),
                            onSkip: ({ ownerRecipient, senderRecipient }) => {
                              monitor.logVerboseMessage(
                                `mattermost: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                              );
                            },
                          }
                        : undefined,
                  }
                : undefined,
            onRecordError: (err) => {
              monitor.logVerboseMessage(
                `mattermost: failed updating session meta id=${post.id ?? "unknown"}: ${String(err)}`,
              );
            },
          },
          history: {
            isGroup: Boolean(historyKey),
            historyKey: historyKey ?? undefined,
            historyMap: channelHistories,
            limit: historyLimit,
          },
          dispatcherOptions,
          delivery,
          replyOptions: {
            ...(turnAdoptionLifecycle
              ? bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle)
              : {}),
            allowProgressCallbacksWhenSourceDeliverySuppressed: draftProgressEnabled
              ? true
              : undefined,
            preserveProgressCallbackStartOrder: draftPreviewEnabled ? true : undefined,
            onObservedReplyDelivery: draftProgressEnabled ? () => draftStream.clear() : undefined,
            disableBlockStreaming: draftPreviewEnabled ? true : replyOptions.disableBlockStreaming,
            ...(suppressDefaultToolProgressMessages
              ? { suppressDefaultToolProgressMessages: true }
              : {}),
            onModelSelected,
            onPartialReply: (payloadResult) =>
              account.streamingMode === "progress"
                ? false
                : updateDraftFromPartial(payloadResult.text),
            onAssistantMessageStart: () => {
              lastPartialText = "";
              progressDraft.beginAssistantMessage();
              if (account.streamingMode === "block") {
                blockPreviewAssistantMessagePending = true;
                return false;
              }
              return false;
            },
            onReasoningEnd: () => {
              // Hidden reasoning has no boundary; only rendered text, reasoning, or tools rotate preview posts.
              lastPartialText = "";
              progressDraft.resetReasoningProgress();
              return false;
            },
            onReasoningStream: async (payloadResult) => {
              if (account.streamingMode === "progress") {
                return await progressDraft.pushReasoningProgress(
                  payloadResult.text || "Thinking…",
                  {
                    snapshot: payloadResult.isReasoningSnapshot === true,
                  },
                );
              }
              if (!lastPartialText) {
                const boundarySettled = enterBlockPreviewActivity("reasoning");
                draftStream.update("Thinking…");
                previewBoundaryController.noteUpdate();
                await boundarySettled;
              }
              return false;
            },
            onPlanUpdate: async (payloadValue) => {
              if (!draftProgressEnabled || payloadValue.phase !== "update") {
                return false;
              }
              const boundarySettled = enterBlockPreviewActivity("tool");
              const progressSettled = progressDraft.pushPlanProgress(payloadValue.steps, {
                explanation: payloadValue.explanation,
              });
              previewBoundaryController.noteUpdate();
              const [, visible] = await Promise.all([boundarySettled, progressSettled]);
              return visible;
            },
            onToolStart: async (payloadValue) => {
              if (!draftProgressEnabled) {
                return false;
              }
              const boundarySettled = enterBlockPreviewActivity("tool");
              // Boundary detach and progress staging both happen synchronously before
              // their first await; agent callbacks may be dispatched fire-and-forget.
              const progressSettled = progressDraft.pushToolProgress(
                buildChannelProgressDraftLineForEntry(
                  account.config,
                  {
                    event: "tool",
                    itemId: payloadValue.itemId,
                    toolCallId: payloadValue.toolCallId,
                    name: payloadValue.name,
                    phase: payloadValue.phase,
                    args: payloadValue.args,
                  },
                  payloadValue.detailMode ? { detailMode: payloadValue.detailMode } : undefined,
                ),
                { startImmediately: true },
              );
              previewBoundaryController.noteUpdate();
              const [, visible] = await Promise.all([boundarySettled, progressSettled]);
              return visible;
            },
            onItemEvent: async (payloadLocal) => {
              if (!draftProgressEnabled) {
                return false;
              }
              const boundarySettled = enterBlockPreviewActivity("tool");
              const progressSettled = progressDraft.pushItemEvent(payloadLocal);
              previewBoundaryController.noteUpdate();
              const [, visible] = await Promise.all([boundarySettled, progressSettled]);
              return visible;
            },
          },
        }),
      },
    });
  } finally {
    try {
      await draftStream.stop();
    } catch (err) {
      monitor.logVerboseMessage(`mattermost draft preview cleanup failed: ${String(err)}`);
    }
  }
}
