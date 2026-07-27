// Mattermost plugin module owns one accepted message's reply turn and delivery.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftCompositor,
} from "openclaw/plugin-sdk/channel-outbound";
import type { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveInboundLastRouteSessionKey,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";
import type { MattermostPost } from "./client.js";
import {
  createMattermostDraftPreviewBoundaryController,
  createMattermostDraftStream,
} from "./draft-stream.js";
import { normalizeMattermostAllowEntry } from "./monitor-auth.js";
import {
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostReplyRootId,
  shouldSuppressMattermostDefaultToolProgressMessages,
  shouldUpdateMattermostDraftToolProgress,
} from "./monitor-context.js";
import {
  deliverMattermostReplyWithDraftPreview,
  type MattermostDraftPreviewState,
} from "./monitor-draft-delivery.js";
import type { MattermostIngressLifecycle } from "./monitor-ingress.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import {
  createMattermostReplyDeliveryBarrier,
  deliverMattermostReplyPayload,
} from "./reply-delivery.js";
import type { ChatType, HistoryEntry, ReplyPayload } from "./runtime-api.js";
import { createChannelMessageReplyPipeline, logTypingFailure } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import { recordMattermostThreadParticipation } from "./thread-participation.js";

type MattermostInboundTurnParams = {
  post: MattermostPost;
  rawText: string;
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  kind: ChatType;
  route: ResolvedAgentRoute;
  channelId: string;
  senderId: string;
  to: string;
  effectiveReplyToId?: string;
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
    discardPending: noopAsync,
    seal: noopAsync,
    stop: noopAsync,
    forceNewMessage: noopAsync,
    settleBoundaries: noopAsync,
    resolveFinalText: (text) => ({ kind: "full", text }),
  };
}

export async function dispatchMattermostInboundTurn(
  monitor: MattermostMonitorContext,
  params: MattermostInboundTurnParams,
): Promise<void> {
  const { account, cfg, client, core, runtime } = monitor;
  const { sendTypingIndicator } = monitor.resources;
  const {
    channelHistories,
    channelId,
    ctxPayload,
    effectiveReplyToId,
    historyKey,
    historyLimit,
    kind,
    pinnedMainDmOwner,
    post,
    rawText,
    route,
    senderId,
    to,
    turnAdoptionLifecycle,
  } = params;
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, {
    fallbackLimit: account.textChunkLimit ?? 4000,
  });
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "mattermost", account.accountId);
  const { onModelSelected, typingCallbacks, resolveResponsePrefix, ...replyPipeline } =
    createChannelMessageReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: "mattermost",
      accountId: account.accountId,
      typing: {
        start: () => sendTypingIndicator(channelId, effectiveReplyToId),
        onStartError: (err) => {
          logTypingFailure({
            log: monitor.logDebugMessage,
            channel: "mattermost",
            target: channelId,
            error: err,
          });
        },
      },
    });
  const draftPreviewEnabled = account.streamingMode !== "off";
  const draftToolProgressEnabled = shouldUpdateMattermostDraftToolProgress(account);
  const suppressDefaultToolProgressMessages =
    shouldSuppressMattermostDefaultToolProgressMessages(account);
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
    update: async (previewText, options) => {
      draftStream.update(previewText);
      if (options?.flush) {
        await draftStream.flush();
      }
    },
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
      progressDraft.reset();
    }
    blockPreviewActivity = activity;
    blockPreviewAssistantMessagePending = false;
    if (activity === "tool") {
      lastPartialText = "";
    }
    return boundarySettled;
  };
  const previewState: MattermostDraftPreviewState = { finalizedViaPreviewPost: false };

  const resolvePreviewFinalText = (text?: string) => {
    if (typeof text !== "string") {
      return undefined;
    }
    const resolution = draftStream.resolveFinalText(text);
    const deliveryText = resolution.kind === "already-delivered" ? "" : resolution.text;
    const formatted = core.channel.text.convertMarkdownTables(deliveryText, tableMode);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(formatted, textLimit, chunkMode);
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    if (chunks.length !== 1) {
      return undefined;
    }
    const trimmed = chunks[0]?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (
      lastPartialText &&
      lastPartialText.startsWith(trimmed) &&
      trimmed.length < lastPartialText.length
    ) {
      return undefined;
    }
    return trimmed;
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

  const deliveryBarrier = createMattermostReplyDeliveryBarrier({
    isDirect: kind === "direct",
    dmRetryOptions: account.config.dmChannelRetry,
  });
  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    ...replyPipeline,
    resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
    onDeliverySettled: deliveryBarrier.markDeliverySettled,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    typingCallbacks,
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    deliver: async (payloadEntry: ReplyPayload, info) => {
      if (info.kind === "final") {
        await enterBlockPreviewActivity("text");
        // Final text uses only confirmed-visible generations, so join prior boundary work before deciding whether to edit in place.
        await draftStream.settleBoundaries();
        progressDraft.markFinalReplyStarted();
      }
      // A visible same-thread final can be a send or an in-place draft edit; either path records participation.
      const markThreadParticipation = () => {
        if (kind !== "direct" && effectiveReplyToId) {
          recordMattermostThreadParticipation(account.accountId, channelId, effectiveReplyToId, {
            agentId: route.agentId,
          });
        }
      };
      await deliverMattermostReplyWithDraftPreview({
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
          const outcome = await deliverMattermostReplyPayload({
            core,
            cfg,
            payload: resolvedPayload,
            to,
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
            onDmChannelResolution: deliveryBarrier.trackDmChannelResolution,
          });
          // Record only visible sends so reasoning-only, empty, or suppressed threads do not auto-engage later.
          if (outcome === "text" || outcome === "media") {
            markThreadParticipation();
          } else if (outcome === "empty" && finalTextResolution?.kind === "already-delivered") {
            // The terminal payload confirms the already-published assistant block as
            // the visible final reply even though this delivery has no remaining text.
            markThreadParticipation();
          }
          const deliveryLog = formatMattermostFinalDeliveryOutcomeLog({
            outcome,
            payload: resolvedPayload,
            to,
            accountId: account.accountId,
            agentId: route.agentId,
          });
          if (deliveryLog) {
            runtime.log?.(deliveryLog);
          }
        },
      });
      if (info.kind === "final") {
        progressDraft.markFinalReplyDelivered();
      }
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
            allowProgressCallbacksWhenSourceDeliverySuppressed: draftToolProgressEnabled
              ? true
              : undefined,
            preserveProgressCallbackStartOrder: draftPreviewEnabled ? true : undefined,
            onObservedReplyDelivery: draftToolProgressEnabled
              ? () => draftStream.clear()
              : undefined,
            disableBlockStreaming: draftPreviewEnabled
              ? true
              : typeof account.blockStreaming === "boolean"
                ? !account.blockStreaming
                : undefined,
            ...(suppressDefaultToolProgressMessages
              ? { suppressDefaultToolProgressMessages: true }
              : {}),
            onModelSelected,
            onPartialReply: (payloadResult) =>
              account.streamingMode === "progress"
                ? undefined
                : updateDraftFromPartial(payloadResult.text),
            onAssistantMessageStart: () => {
              lastPartialText = "";
              progressDraft.resetReasoningProgress();
              if (account.streamingMode === "block") {
                blockPreviewAssistantMessagePending = true;
                return;
              }
              if (account.streamingMode !== "progress") {
                progressDraft.reset();
              }
            },
            onReasoningEnd: () => {
              // Hidden reasoning has no boundary; only rendered text, reasoning, or tools rotate preview posts.
              lastPartialText = "";
              progressDraft.resetReasoningProgress();
              if (account.streamingMode !== "block" && account.streamingMode !== "progress") {
                progressDraft.reset();
              }
            },
            onReasoningStream: async (payloadResult) => {
              if (account.streamingMode === "progress") {
                await progressDraft.pushReasoningProgress(payloadResult.text || "Thinking…", {
                  snapshot: payloadResult.isReasoningSnapshot === true,
                });
                return;
              }
              if (!lastPartialText) {
                const boundarySettled = enterBlockPreviewActivity("reasoning");
                draftStream.update("Thinking…");
                previewBoundaryController.noteUpdate();
                await boundarySettled;
              }
            },
            onToolStart: async (payloadValue) => {
              if (!draftToolProgressEnabled) {
                return;
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
              await Promise.all([boundarySettled, progressSettled]);
            },
            onItemEvent: async (payloadLocal) => {
              if (!draftToolProgressEnabled) {
                return;
              }
              const boundarySettled = enterBlockPreviewActivity("tool");
              const progressSettled = progressDraft.pushToolProgress(
                buildChannelProgressDraftLineForEntry(account.config, {
                  event: "item",
                  itemId: payloadLocal.itemId,
                  itemKind: payloadLocal.kind,
                  title: payloadLocal.title,
                  name: payloadLocal.name,
                  phase: payloadLocal.phase,
                  status: payloadLocal.status,
                  summary: payloadLocal.summary,
                  progressText: payloadLocal.progressText,
                  meta: payloadLocal.meta,
                }),
                { startImmediately: true },
              );
              previewBoundaryController.noteUpdate();
              await Promise.all([boundarySettled, progressSettled]);
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
