import { resolveAckReaction, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import { deliverFinalizableDraftPreview } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createChannelReplyPipeline,
  resolveChannelSourceReplyDeliveryMode,
} from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import {
  hasFinalInboundReplyDispatch,
  runInboundReplyTurn,
} from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { createDiscordRestClient } from "../client.js";
import { removeReactionDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { resolveForwardedMediaList, resolveMediaList } from "./message-utils.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
} from "./timeouts.js";
import { sendTyping } from "./typing.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DISCORD_TYPING_MAX_DURATION_MS = 20 * 60_000;
let replyRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/reply-runtime")> | undefined;

async function loadReplyRuntime() {
  replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
  return await replyRuntimePromise;
}

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function formatDiscordReplyDeliveryFailure(params: {
  kind: string;
  err: unknown;
  target: string;
  sessionKey?: string;
}) {
  const context = [
    `target=${params.target}`,
    params.sessionKey ? `session=${params.sessionKey}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `discord ${params.kind} reply failed (${context}): ${String(params.err)}`;
}

type DiscordMessageProcessObserver = {
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  onReplyPlanResolved?: (params: { createdThreadId?: string; sessionKey?: string }) => void;
};

export async function processDiscordMessage(
  ctx: DiscordMessagePreflightContext,
  observer?: DiscordMessageProcessObserver,
) {
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    ackReactionScope,
    message,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    messageText,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    channelConfig,
    threadBindings,
    route,
    discordRestFetch,
    abortSignal,
  } = ctx;
  if (isProcessAborted(abortSignal)) {
    return;
  }

  const ssrfPolicy = cfg.browser?.ssrfPolicy;
  const mediaResolveOptions = {
    fetchImpl: discordRestFetch,
    ssrfPolicy,
    readIdleTimeoutMs: DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
    abortSignal,
  };
  const mediaList = await resolveMediaList(message, mediaMaxBytes, mediaResolveOptions);
  if (isProcessAborted(abortSignal)) {
    return;
  }
  const forwardedMediaList = await resolveForwardedMediaList(
    message,
    mediaMaxBytes,
    mediaResolveOptions,
  );
  if (isProcessAborted(abortSignal)) {
    return;
  }
  mediaList.push(...forwardedMediaList);
  const text = messageText;
  if (!text) {
    logVerbose("discord: drop message " + message.id + " (empty content)");
    return;
  }

  const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
  if (boundThreadId && typeof threadBindings.touchThread === "function") {
    threadBindings.touchThread({ threadId: boundThreadId });
  }
  const { createReplyDispatcherWithTyping, dispatchInboundMessage, settleReplyDispatcher } =
    await loadReplyRuntime();
  const sourceReplyDeliveryMode = resolveChannelSourceReplyDeliveryMode({
    cfg,
    ctx: { ChatType: isGuildMessage ? "channel" : undefined },
  });
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: isDirectMessage,
        isGroup: isGuildMessage || isGroupDm,
        isMentionableGroup: isGuildMessage,
        requireMention: shouldRequireMention,
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  const shouldSendAckReaction = shouldAckReaction();
  const statusReactionsEnabled =
    !sourceRepliesAreToolOnly &&
    shouldSendAckReaction &&
    cfg.messages?.statusReactions?.enabled !== false;
  const feedbackRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest;
  const deliveryRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest;
  // Discord outbound helpers expect the internal REST client shape explicitly.
  const ackReactionContext = createDiscordAckReactionContext({
    rest: feedbackRest,
    cfg,
    accountId,
  });
  const discordAdapter = createDiscordAckReactionAdapter({
    channelId: messageChannelId,
    messageId: message.id,
    reactionContext: ackReactionContext,
  });
  const statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: discordAdapter,
    initialEmoji: ackReaction,
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${messageChannelId}/${message.id}`,
        error: err,
      });
    },
  });
  queueInitialDiscordAckReaction({
    enabled: statusReactionsEnabled,
    shouldSendAckReaction,
    ackReaction,
    statusReactions,
    reactionAdapter: discordAdapter,
    target: `${messageChannelId}/${message.id}`,
  });
  const processContext = await buildDiscordMessageProcessContext({
    ctx,
    text,
    mediaList,
  });
  if (!processContext) {
    return;
  }
  const {
    ctxPayload,
    persistedSessionKey,
    turn,
    replyPlan,
    deliverTarget,
    replyTarget,
    replyReference,
  } = processContext;
  observer?.onReplyPlanResolved?.({
    createdThreadId: replyPlan.createdThreadId,
    sessionKey: persistedSessionKey,
  });

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
    typing: {
      start: () => sendTyping({ rest: feedbackRest, channelId: typingChannelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "discord",
          target: typingChannelId,
          error: err,
        });
      },
      // Long tool-heavy runs are expected on Discord; keep heartbeats alive.
      maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS,
    },
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId,
  });
  const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
    cfg,
    discordConfig,
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountId);

  const deliverChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  const draftPreview = createDiscordDraftPreviewController({
    cfg,
    discordConfig,
    accountId,
    sourceRepliesAreToolOnly,
    textLimit,
    deliveryRest,
    deliverChannelId,
    replyReference,
    tableMode,
    maxLinesPerMessage,
    chunkMode,
    log: logVerbose,
  });
  let finalReplyStartNotified = false;
  const notifyFinalReplyStart = () => {
    if (finalReplyStartNotified) {
      return;
    }
    finalReplyStartNotified = true;
    observer?.onFinalReplyStart?.();
  };

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload, info) => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        const isFinal = info.kind === "final";
        if (payload.isReasoning) {
          // Reasoning/thinking payloads should not be delivered to Discord.
          return;
        }
        const draftStream = draftPreview.draftStream;
        if (draftStream && isFinal) {
          draftPreview.markFinalDeliveryHandled();
          const reply = resolveSendableOutboundReplyParts(payload);
          const hasMedia = reply.hasMedia;
          const finalText = payload.text;
          const previewFinalText = draftPreview.resolvePreviewFinalText(finalText);
          const hasExplicitReplyDirective =
            Boolean(payload.replyToTag || payload.replyToCurrent) ||
            (typeof finalText === "string" && /\[\[\s*reply_to(?:_current|\s*:)/i.test(finalText));

          const result = await deliverFinalizableDraftPreview({
            kind: info.kind,
            payload,
            draft: {
              flush: () => draftPreview.flush(),
              clear: () => draftStream.clear(),
              discardPending: () => draftStream.discardPending(),
              seal: () => draftStream.seal(),
              id: draftStream.messageId,
            },
            buildFinalEdit: () => {
              if (
                draftPreview.finalizedViaPreviewMessage ||
                hasMedia ||
                typeof previewFinalText !== "string" ||
                hasExplicitReplyDirective ||
                payload.isError
              ) {
                return undefined;
              }
              return { content: previewFinalText };
            },
            editFinal: async (previewMessageId, edit) => {
              if (isProcessAborted(abortSignal)) {
                throw new Error("process aborted");
              }
              notifyFinalReplyStart();
              await editMessageDiscord(deliverChannelId, previewMessageId, edit, {
                cfg,
                accountId,
                rest: deliveryRest,
              });
            },
            deliverNormally: async () => {
              if (isProcessAborted(abortSignal)) {
                return false;
              }
              const replyToId = replyReference.use();
              notifyFinalReplyStart();
              await deliverDiscordReply({
                cfg,
                replies: [payload],
                target: deliverTarget,
                token,
                accountId,
                rest: deliveryRest,
                runtime,
                replyToId,
                replyToMode,
                textLimit,
                maxLinesPerMessage,
                tableMode,
                chunkMode,
                sessionKey: ctxPayload.SessionKey,
                threadBindings,
                mediaLocalRoots,
              });
              replyReference.markSent();
              observer?.onFinalReplyDelivered?.();
              return true;
            },
            onPreviewFinalized: () => {
              draftPreview.markPreviewFinalized();
              replyReference.markSent();
              observer?.onFinalReplyDelivered?.();
            },
            logPreviewEditFailure: (err) => {
              logVerbose(
                `discord: preview final edit failed; falling back to standard send (${String(err)})`,
              );
            },
          });
          if (result !== "normal-skipped") {
            return;
          }
        }
        if (isProcessAborted(abortSignal)) {
          return;
        }

        const replyToId = replyReference.use();
        if (isFinal) {
          notifyFinalReplyStart();
        }
        await deliverDiscordReply({
          cfg,
          replies: [payload],
          target: deliverTarget,
          token,
          accountId,
          rest: deliveryRest,
          runtime,
          replyToId,
          replyToMode,
          textLimit,
          maxLinesPerMessage,
          tableMode,
          chunkMode,
          sessionKey: ctxPayload.SessionKey,
          threadBindings,
          mediaLocalRoots,
        });
        replyReference.markSent();
        if (isFinal) {
          observer?.onFinalReplyDelivered?.();
        }
      },
      onError: (err, info) => {
        runtime.error?.(
          danger(
            formatDiscordReplyDeliveryFailure({
              kind: info.kind,
              err,
              target: deliverTarget,
              sessionKey: ctxPayload.SessionKey,
            }),
          ),
        );
      },
      onReplyStart: async () => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        await replyPipeline.typingCallbacks?.onReplyStart();
        await statusReactions.setThinking();
      },
    });

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);
  let dispatchResult: Awaited<ReturnType<typeof dispatchInboundMessage>> | null = null;
  let dispatchError = false;
  let dispatchAborted = false;
  let dispatchSettledBeforeStart = false;
  const settleDispatchBeforeStart = async () => {
    dispatchSettledBeforeStart = true;
    await settleReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markRunComplete();
        markDispatchIdle();
      },
    });
  };
  try {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      await settleDispatchBeforeStart();
      return;
    }
    const preparedResult = await runInboundReplyTurn({
      channel: "discord",
      accountId: route.accountId,
      raw: ctx,
      adapter: {
        ingest: () => ({
          id: message.id,
          timestamp: message.timestamp ? Date.parse(message.timestamp) : undefined,
          rawText: text,
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: message,
        }),
        resolveTurn: () => ({
          channel: "discord",
          accountId: route.accountId,
          routeSessionKey: persistedSessionKey,
          storePath: turn.storePath,
          ctxPayload,
          recordInboundSession,
          record: turn.record,
          history: {
            isGroup: isGuildMessage,
            historyKey: messageChannelId,
            historyMap: guildHistories,
            limit: historyLimit,
          },
          onPreDispatchFailure: settleDispatchBeforeStart,
          runDispatch: () =>
            dispatchInboundMessage({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                abortSignal,
                skillFilter: channelConfig?.skills,
                sourceReplyDeliveryMode,
                disableBlockStreaming: sourceRepliesAreToolOnly
                  ? true
                  : (draftPreview.disableBlockStreamingForDraft ??
                    (typeof resolvedBlockStreamingEnabled === "boolean"
                      ? !resolvedBlockStreamingEnabled
                      : undefined)),
                onPartialReply: draftPreview.draftStream
                  ? (payload) => draftPreview.updateFromPartial(payload.text)
                  : undefined,
                onAssistantMessageStart: draftPreview.draftStream
                  ? draftPreview.handleAssistantMessageBoundary
                  : undefined,
                onReasoningEnd: draftPreview.draftStream
                  ? draftPreview.handleAssistantMessageBoundary
                  : undefined,
                onModelSelected,
                suppressDefaultToolProgressMessages: draftPreview.previewToolProgressEnabled
                  ? true
                  : undefined,
                onReasoningStream: async () => {
                  await statusReactions.setThinking();
                },
                onToolStart: async (payload) => {
                  if (isProcessAborted(abortSignal)) {
                    return;
                  }
                  await statusReactions.setTool(payload.name);
                  draftPreview.pushToolProgress(
                    payload.name ? `tool: ${payload.name}` : "tool running",
                  );
                },
                onItemEvent: async (payload) => {
                  draftPreview.pushToolProgress(
                    payload.progressText ?? payload.summary ?? payload.title ?? payload.name,
                  );
                },
                onPlanUpdate: async (payload) => {
                  if (payload.phase !== "update") {
                    return;
                  }
                  draftPreview.pushToolProgress(
                    payload.explanation ?? payload.steps?.[0] ?? "planning",
                  );
                },
                onApprovalEvent: async (payload) => {
                  if (payload.phase !== "requested") {
                    return;
                  }
                  draftPreview.pushToolProgress(
                    payload.command ? `approval: ${payload.command}` : "approval requested",
                  );
                },
                onCommandOutput: async (payload) => {
                  if (payload.phase !== "end") {
                    return;
                  }
                  draftPreview.pushToolProgress(
                    payload.name
                      ? `${payload.name}${payload.exitCode === 0 ? " ✓" : payload.exitCode != null ? ` (exit ${payload.exitCode})` : ""}`
                      : payload.title,
                  );
                },
                onPatchSummary: async (payload) => {
                  if (payload.phase !== "end") {
                    return;
                  }
                  draftPreview.pushToolProgress(
                    payload.summary ?? payload.title ?? "patch applied",
                  );
                },
                onCompactionStart: async () => {
                  if (isProcessAborted(abortSignal)) {
                    return;
                  }
                  await statusReactions.setCompacting();
                },
                onCompactionEnd: async () => {
                  if (isProcessAborted(abortSignal)) {
                    return;
                  }
                  statusReactions.cancelPending();
                  await statusReactions.setThinking();
                },
              },
            }),
        }),
      },
    });
    if (!preparedResult.dispatched) {
      return;
    }
    dispatchResult = preparedResult.dispatchResult;
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
  } catch (err) {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchError = true;
    throw err;
  } finally {
    try {
      await draftPreview.cleanup();
    } finally {
      if (!dispatchSettledBeforeStart) {
        markRunComplete();
        markDispatchIdle();
      }
    }
    if (statusReactionsEnabled) {
      if (dispatchAborted) {
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
      } else {
        if (dispatchError) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
        if (removeAckAfterReply) {
          void (async () => {
            await sleep(dispatchError ? DEFAULT_TIMING.errorHoldMs : DEFAULT_TIMING.doneHoldMs);
            await statusReactions.clear();
          })();
        } else {
          void statusReactions.restoreInitial();
        }
      }
    } else if (shouldSendAckReaction && ackReaction && removeAckAfterReply) {
      void removeReactionDiscord(
        messageChannelId,
        message.id,
        ackReaction,
        ackReactionContext,
      ).catch((err: unknown) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: `${messageChannelId}/${message.id}`,
          error: err,
        });
      });
    }
  }
  if (dispatchAborted) {
    return;
  }

  const finalDispatchResult = dispatchResult;
  if (!finalDispatchResult || !hasFinalInboundReplyDispatch(finalDispatchResult)) {
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = finalDispatchResult.counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
}
