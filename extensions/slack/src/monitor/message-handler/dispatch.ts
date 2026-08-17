// Slack plugin module implements dispatch behavior.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  dispatchChannelInboundTurn,
  readAgentRunTerminalOutcome,
  type InboundReplyRecordOptions,
  hasVisibleInboundReplyDispatch,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload, ReplyDispatchKind } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "../../limits.js";
import { emitSlackMessageSentHooks } from "../../message-sent-hook.js";
import { resolveSlackReplyRenderPlan } from "../../reply-blocks.js";
import {
  clearSlackThreadFailureNotice,
  hasSlackThreadFailureNotice,
  hasSlackThreadParticipation,
  recordSlackThreadFailureNotice,
  recordSlackThreadParticipation,
} from "../../sent-thread-cache.js";
import {
  SlackStreamNotDeliveredError,
  stopSlackStream,
  type SlackStreamSession,
} from "../../streaming.js";
import { countSlackTextUtf8Bytes } from "../../truncate.js";
import { resolveSlackBotLoopProtection } from "./dispatch-helpers.js";
import { createSlackProgressRuntime } from "./dispatch-progress.js";
import { createSlackDispatchSetup } from "./dispatch-setup.js";
import { createSlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";
import type { PreparedSlackMessage } from "./types.js";

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const setup = await createSlackDispatchSetup(prepared);
  const {
    account,
    cfg,
    ctx,
    disableBlockStreaming,
    hasSlackCustomIdentity,
    hasRepliedRef,
    message,
    messageSentHookContext,
    messageSentHookTarget,
    onModelSelected,
    onSlackDeliveryError,
    previewStreamingEnabled,
    replyPipeline,
    replyPlan,
    route,
    runtime,
    slackClient,
    slackMessageMetadata,
    slackStreaming,
    sourceReplyDeliveryMode,
    statusReactions,
    statusReactionsEnabled,
    statusThreadTs,
    suppressRoomEventTyping,
    useStreaming,
  } = setup;
  const delivery = createSlackStreamingDeliveryRuntime(setup);
  const draftPreviewCommitted = { value: false };
  const progress = createSlackProgressRuntime({
    setup,
    delivery,
    resetPreviewDeliveryState: () => {
      draftPreviewCommitted.value = false;
      delivery.observedFinalReplyDelivery = false;
    },
  });
  const draftStream = progress.draftStream;
  // A posted draft/progress message counts as visible output even before it is
  // committed as the reply, so the status keepalive stops at the same moment
  // Slack drops the status row.
  setup.threadStatusGate.hasVisibleOutput = () =>
    delivery.observedReplyDelivery ||
    draftPreviewCommitted.value ||
    Boolean(draftStream?.messageId());
  const failureNoticeThreadTs = message.thread_ts;
  const failureNoticeTeamId = prepared.eventScope?.teamId;
  let sawTerminalFailurePayload = false;
  let pendingFailureNotice:
    | {
        accountId: string;
        channelId: string;
        threadTs?: string;
        failureText: string;
        teamId?: string;
      }
    | undefined;

  const filterPassiveThreadFailure = (payload: ReplyPayload): ReplyPayload | null => {
    if (
      payload.isError !== true ||
      prepared.ctxPayload.ChatType !== "channel" ||
      isReplyPayloadNonTerminalToolErrorWarning(payload)
    ) {
      return payload;
    }
    sawTerminalFailurePayload = true;
    if (delivery.observedReplyDelivery || draftPreviewCommitted.value) {
      return payload;
    }

    const explicitlyAddressed =
      prepared.ctxPayload.ExplicitlyMentionedBot === true ||
      prepared.ctxPayload.MentionSource === "explicit_bot" ||
      prepared.ctxPayload.MentionSource === "subteam" ||
      prepared.ctxPayload.MentionSource === "mention_pattern" ||
      prepared.ctxPayload.MentionSource === "command_bypass" ||
      (prepared.ctxPayload.CommandTurn?.kind !== undefined &&
        prepared.ctxPayload.CommandTurn.kind !== "normal" &&
        prepared.ctxPayload.CommandTurn.authorized);
    const noticeThreadTs =
      failureNoticeThreadTs ?? (explicitlyAddressed ? statusThreadTs : undefined);

    const notice = {
      accountId: account.accountId,
      channelId: message.channel,
      ...(noticeThreadTs ? { threadTs: noticeThreadTs } : {}),
      failureText: payload.text ?? "",
      ...(failureNoticeTeamId ? { teamId: failureNoticeTeamId } : {}),
    };
    if (
      failureNoticeThreadTs &&
      !explicitlyAddressed &&
      prepared.ctxPayload.MentionSource !== "implicit_thread" &&
      !hasSlackThreadParticipation(
        notice.accountId,
        notice.channelId,
        failureNoticeThreadTs,
        failureNoticeTeamId,
      )
    ) {
      logVerbose("slack: suppressed passive failure before thread participation");
      return null;
    }

    if (!explicitlyAddressed && hasSlackThreadFailureNotice(notice)) {
      logVerbose("slack: suppressed repeated passive channel or thread failure");
      return null;
    }
    pendingFailureNotice = notice;
    return payload;
  };

  const deliverSlackPayload = async (
    payload: ReplyPayload,
    info: { kind: ReplyDispatchKind },
  ): Promise<{ visibleReplySent: false } | void> => {
    if (payload.isReasoning === true) {
      return { visibleReplySent: false };
    }
    if (info.kind === "final" && slackStreaming.mode === "progress" && progress.isProgressMode) {
      if (progress.useNativeProgressStreaming) {
        await progress.deliverNativeFinal(payload, info.kind);
        return;
      }
      progress.progressDraft.markFinalReplyStarted();
      if (progress.useDraftProgressCard) {
        await delivery.deliverNormally({
          payload,
          kind: info.kind,
          forcedThreadTs: delivery.usedReplyThreadTs,
        });
        const finalized = await progress.finalizeDraftProgressCard(
          payload.isError === true ? "error" : "success",
        );
        // The final reply already landed separately. A card that could not be
        // terminalized would linger in its Working state and misrepresent an
        // in-progress turn, so drop it (mirrors the pre-card preview cleanup).
        if (!finalized) {
          await draftStream?.clear();
        }
        progress.progressDraft.markFinalReplyDelivered();
        return;
      }
    }
    if (progress.useNativeProgressStreaming) {
      if (info.kind !== "final" && payload.isError !== true) {
        if (!delivery.isStreamingEligible(payload)) {
          await delivery.deliverNormally({
            payload,
            kind: info.kind,
            forcedThreadTs:
              delivery.streamSession?.threadTs ?? delivery.nativeProgressStreamThreadTs,
          });
          return;
        }
        return (await progress.appendNativeNarration(payload, info.kind))
          ? undefined
          : { visibleReplySent: false };
      }
      await delivery.deliverNormally({
        payload,
        kind: info.kind,
        forcedThreadTs: delivery.streamSession?.threadTs ?? delivery.nativeProgressStreamThreadTs,
      });
      return;
    }
    if (useStreaming) {
      await delivery.deliverWithStreaming({ payload, kind: info.kind });
      return;
    }

    const reply = resolveSendableOutboundReplyParts(payload);
    const ttsSupplement = getReplyPayloadTtsSupplement(payload);
    const replySourceText = payload.text ?? ttsSupplement?.spokenText;
    const replyRenderPlan = resolveSlackReplyRenderPlan(payload, replySourceText);
    const plannedBlocks =
      replyRenderPlan.mode === "single"
        ? replyRenderPlan.blocks
        : replyRenderPlan.blockPart?.blocks;
    const slackBlocks = plannedBlocks;
    const requiresSeparateFallbackDelivery = replyRenderPlan.mode === "split";
    const trimmedFinalText =
      replyRenderPlan.mode === "single"
        ? replyRenderPlan.text.trim()
        : replyRenderPlan.fallbackText.trim();
    const previewFinalText =
      replyRenderPlan.mode === "single" && replyRenderPlan.textIsSlackMrkdwn
        ? trimmedFinalText
        : normalizeSlackOutboundText((replySourceText ?? "").trim());
    const previewFinalTextFitsEdit =
      countSlackTextUtf8Bytes(previewFinalText) <= SLACK_EDIT_TEXT_MAX_BYTES;
    const shouldRestoreTtsSupplementTextForPreviewFallback =
      Boolean(ttsSupplement) &&
      ttsSupplement?.visibleTextAlreadyDelivered !== true &&
      Boolean(draftStream) &&
      !draftPreviewCommitted.value &&
      !delivery.observedFinalReplyDelivery &&
      previewStreamingEnabled &&
      !payload.text?.trim();

    if (
      info.kind === "final" &&
      ttsSupplement &&
      draftStream &&
      !hasSlackCustomIdentity &&
      !draftPreviewCommitted.value &&
      !delivery.observedFinalReplyDelivery &&
      previewStreamingEnabled &&
      !payload.isError &&
      !requiresSeparateFallbackDelivery &&
      previewFinalTextFitsEdit &&
      trimmedFinalText.length > 0
    ) {
      await draftStream.flush();
      const channelId = draftStream.channelId();
      const messageId = draftStream.messageId();
      if (channelId && messageId) {
        const finalThreadTs = delivery.usedReplyThreadTs ?? statusThreadTs;
        await draftStream.seal();
        try {
          const finalized = await draftStream.finalizeMessage(messageId, async () => {
            await finalizeSlackPreviewEdit({
              client: slackClient,
              token: ctx.botToken,
              accountId: account.accountId,
              channelId,
              messageId,
              text: previewFinalText,
              ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
              threadTs: finalThreadTs,
            });
          });
          if (!finalized) {
            throw new Error("Slack preview moved below a newer conversation message");
          }
        } catch (err) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${formatSlackError(err)})`,
          );
          await draftStream.discardPending();
          let delivered = false;
          try {
            await delivery.deliverNormally({
              payload: payload.text?.trim()
                ? payload
                : {
                    ...payload,
                    // Keep presentation semantic here; deliverReplies adds its
                    // accessible chart summary exactly once.
                    text: ttsSupplement.spokenText,
                  },
              kind: info.kind,
              forcedThreadTs: finalThreadTs,
            });
            delivered = true;
          } finally {
            if (delivered) {
              await draftStream.clear();
            }
          }
          return;
        }
        draftPreviewCommitted.value = true;
        delivery.observedFinalReplyDelivery = true;
        delivery.observedReplyDelivery = true;
        replyPlan.markSent();
        await delivery.deliverNormally({
          payload: buildTtsSupplementMediaPayload(payload),
          kind: info.kind,
          forcedThreadTs: finalThreadTs,
        });
        delivery.markPreviewPayloadDelivered({ kind: info.kind, payload, threadTs: finalThreadTs });
        progress.progressDraft.markFinalReplyDelivered();
        return;
      }
    }

    await deliverWithFinalizableLivePreviewAdapter({
      kind: info.kind,
      payload,
      adapter: defineFinalizableLivePreviewAdapter({
        draft:
          draftStream && !draftPreviewCommitted.value && !delivery.observedFinalReplyDelivery
            ? {
                flush: draftStream.flush,
                clear: draftStream.clear,
                discardPending: draftStream.discardPending,
                seal: draftStream.seal,
                id: () => {
                  const channelId = draftStream.channelId();
                  const messageId = draftStream.messageId();
                  return channelId && messageId ? { channelId, messageId } : undefined;
                },
              }
            : undefined,
        buildFinalEdit: () => {
          if (
            hasSlackCustomIdentity ||
            !previewStreamingEnabled ||
            (reply.hasMedia && !ttsSupplement) ||
            payload.isError ||
            requiresSeparateFallbackDelivery ||
            !previewFinalTextFitsEdit ||
            (trimmedFinalText.length === 0 && !slackBlocks?.length)
          ) {
            return undefined;
          }
          return {
            text: previewFinalText,
            blocks: slackBlocks,
            threadTs: delivery.usedReplyThreadTs ?? statusThreadTs,
          };
        },
        editFinal: async (preview, edit) => {
          if (delivery.hasDelivered({ kind: info.kind, payload, threadTs: edit.threadTs })) {
            return;
          }
          const finalized = await draftStream?.finalizeMessage(preview.messageId, async () => {
            await finalizeSlackPreviewEdit({
              client: slackClient,
              token: ctx.botToken,
              accountId: account.accountId,
              channelId: preview.channelId,
              messageId: preview.messageId,
              text: edit.text,
              ...(edit.blocks?.length ? { blocks: edit.blocks } : {}),
              threadTs: edit.threadTs,
            });
          });
          if (!finalized) {
            throw new Error("Slack preview moved below a newer conversation message");
          }
          if (!ttsSupplement) {
            emitSlackMessageSentHooks({
              ...messageSentHookContext,
              to: messageSentHookTarget,
              accountId: account.accountId,
              content: trimmedFinalText,
              success: true,
              messageId: preview.messageId,
            });
          }
          draftPreviewCommitted.value = true;
          delivery.observedFinalReplyDelivery = true;
        },
        onPreviewFinalized: (_preview) => {
          // The preview edit promotes the draft message into the final answer.
          // Later same-turn payloads must not let fallback cleanup clear it.
          draftPreviewCommitted.value = true;
          delivery.observedFinalReplyDelivery = true;
          const finalThreadTs = delivery.usedReplyThreadTs ?? statusThreadTs;
          delivery.observedReplyDelivery = true;
          replyPlan.markSent();
          // Supplemental TTS media is the terminal delivery for the logical
          // payload. Marking the preview first would suppress that media send.
          if (!ttsSupplement) {
            delivery.markPreviewPayloadDelivered({
              kind: info.kind,
              payload,
              threadTs: finalThreadTs,
            });
          }
        },
        buildSupplementalPayload: () =>
          ttsSupplement ? buildTtsSupplementMediaPayload(payload) : undefined,
        deliverSupplemental: async (supplementalPayload) => {
          const previewThreadTs = delivery.usedReplyThreadTs ?? statusThreadTs;
          const supplementalThreadTs = await delivery.deliverNormally({
            payload: supplementalPayload,
            kind: info.kind,
            forcedThreadTs: previewThreadTs,
          });
          delivery.markPreviewPayloadDelivered({
            kind: info.kind,
            payload,
            threadTs: supplementalThreadTs,
          });
        },
        logPreviewEditFailure: (err) => {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${formatSlackError(err)})`,
          );
        },
      }),
      deliverNormally: async () => {
        await delivery.deliverNormally({
          payload: shouldRestoreTtsSupplementTextForPreviewFallback
            ? {
                ...payload,
                text: ttsSupplement?.spokenText,
              }
            : payload,
          kind: info.kind,
        });
      },
    });
    if (info.kind === "final") {
      progress.progressDraft.markFinalReplyDelivered();
    }
  };
  let dispatchError: unknown;
  let agentRunFailed = false;
  let queuedFinal = false;
  let counts: Partial<Record<ReplyDispatchKind, number>> = {};
  try {
    const turnResult = await dispatchChannelInboundTurn({
      cfg,
      channel: "slack",
      accountId: route.accountId,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      ctxPayload: prepared.ctxPayload,
      dispatcherOptions: {
        ...replyPipeline,
        // A channel transform marks intentional silence before core can synthesize an empty-reply error.
        transformReplyPayload: (payload) => {
          const transformed = replyPipeline.transformReplyPayload
            ? replyPipeline.transformReplyPayload(payload)
            : payload;
          return transformed ? filterPassiveThreadFailure(transformed) : null;
        },
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      },
      delivery: {
        deliver: deliverSlackPayload,
        onError: onSlackDeliveryError,
      },
      record: prepared.turn.record as InboundReplyRecordOptions,
      history: prepared.turn.history,
      botLoopProtection: resolveSlackBotLoopProtection(prepared),
      replyOptions: {
        ...(prepared.turnAdoptionLifecycle
          ? { turnAdoptionLifecycle: prepared.turnAdoptionLifecycle }
          : {}),
        skillFilter: prepared.channelConfig?.skills,
        sourceReplyDeliveryMode,
        // Room events are observe-style turns; Slack status indicators imply an
        // automatic visible reply and can auto-open assistant threads.
        suppressTyping: suppressRoomEventTyping ? true : undefined,
        hasRepliedRef,
        disableBlockStreaming,
        onModelSelected,
        suppressDefaultToolProgressMessages: progress.suppressDefaultToolProgressMessages
          ? true
          : undefined,
        commentaryProgressEnabled: progress.commentaryProgressEnabled ? true : undefined,
        progressPreambleEnabled:
          progress.progressDraftActive && slackStreaming.mode === "progress" ? true : undefined,
        commentaryPayloadsEnabled: progress.commentaryProgressEnabled ? true : undefined,
        shouldDeliverCommentaryPayloads: progress.commentaryProgressEnabled
          ? progress.shouldYieldDraftProgress
          : undefined,
        onVerboseProgressVisibility: progress.commentaryProgressEnabled
          ? (isActive) => {
              progress.setShouldYieldDraftProgress(isActive);
            }
          : undefined,
        allowProgressCallbacksWhenSourceDeliverySuppressed:
          sourceReplyDeliveryMode === "message_tool_only" && statusReactionsEnabled
            ? true
            : undefined,
        allowToolLifecycleWhenProgressHidden: statusReactionsEnabled ? true : undefined,
        onPartialReply: useStreaming
          ? undefined
          : !previewStreamingEnabled
            ? undefined
            : async (payload) => {
                return progress.updateDraftFromPartial(payload.text);
              },
        onAssistantMessageStart: progress.onDraftBoundary
          ? async () => {
              await progress.onDraftBoundary?.();
              return false;
            }
          : undefined,
        onReasoningEnd: async () => {
          await progress.onDraftBoundary?.();
          return false;
        },
        onQueuedFollowupAdmitted: progress.onQueuedFollowupAdmitted,
        onQueuedFollowupSettled: progress.onQueuedFollowupSettled,
        onReasoningStream:
          statusReactionsEnabled || progress.previewToolProgressEnabled
            ? async (payload) => {
                const visible = await progress.pushReasoningProgress(payload);
                if (!statusReactionsEnabled) {
                  return visible;
                }
                await statusReactions.setThinking();
                return visible;
              }
            : undefined,
        onToolStart: async (payload) => {
          if (statusReactionsEnabled) {
            await statusReactions.setTool(payload.name);
          }
          if (payload.phase === "start") {
            progress.progressReceipt.noteToolCall(payload.name);
          }
          return await progress.progressDraft.pushToolEvent(payload);
        },
        onItemEvent: async (payload) => {
          if (progress.isProgressMode && payload.kind === "preamble") {
            if (progress.shouldYieldDraftProgress()) {
              return false;
            }
            const headlineVisible = await progress.progressDraft.pushPreambleHeadline(
              payload.progressText,
              {
                itemId: payload.itemId,
              },
            );
            if (progress.commentaryProgressEnabled) {
              const accepted = await progress.progressDraft.pushCommentaryProgress(
                payload.progressText,
                {
                  itemId: payload.itemId,
                },
              );
              return accepted || headlineVisible;
            }
            return headlineVisible;
          }
          return await progress.progressDraft.pushItemEvent(payload);
        },
        onPlanUpdate: async (payload) => {
          if (payload.phase !== "update") {
            return false;
          }
          return await progress.pushPlanProgress(payload.steps, payload.explanation);
        },
        onApprovalEvent: async (payload) => {
          return await progress.progressDraft.pushApprovalEvent(payload);
        },
        onCommandOutput: async (payload) => {
          return await progress.progressDraft.pushCommandOutputEvent(payload);
        },
        onPatchSummary: async (payload) => {
          return await progress.progressDraft.pushPatchEvent(payload);
        },
      },
    });
    if (turnResult.dispatched) {
      const result = turnResult.dispatchResult;
      queuedFinal = result.queuedFinal;
      counts = result.counts;
      const agentRunOutcome = readAgentRunTerminalOutcome(result);
      agentRunFailed = agentRunOutcome === "failed";
      if (
        agentRunOutcome === "completed" &&
        !sawTerminalFailurePayload &&
        prepared.ctxPayload.ChatType === "channel"
      ) {
        clearSlackThreadFailureNotice({
          accountId: account.accountId,
          channelId: message.channel,
          ...(failureNoticeThreadTs ? { threadTs: failureNoticeThreadTs } : {}),
          ...(failureNoticeTeamId ? { teamId: failureNoticeTeamId } : {}),
        });
      }
    }
  } catch (err) {
    dispatchError = err;
  } finally {
    progress.progressDraft.cancel();
    if (!progress.useDraftProgressCard) {
      await draftStream?.discardPending();
    }
  }

  // -----------------------------------------------------------------------
  // Finalize the stream if one was started
  // -----------------------------------------------------------------------
  let streamFallbackDelivered = false;
  const finalStream = delivery.streamSession as SlackStreamSession | null;
  if (finalStream && !finalStream.stopped) {
    try {
      const completionChunks =
        progress.useNativeProgressStreaming && !progress.nativeProgressCompletionSent
          ? progress.buildNativeProgressCompletionChunks(
              dispatchError || agentRunFailed ? "error" : progress.nativeProgressTerminalStatus,
            )
          : undefined;
      if (completionChunks?.length) {
        progress.nativeProgressCompletionSent = true;
      }
      const stopResult = await stopSlackStream({
        session: finalStream,
        ...(completionChunks?.length ? { chunks: completionChunks } : {}),
        ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
      });
      // The stream finalized successfully, flushing any buffered text to Slack.
      // Emit the `message_sent` plugin hook for every streamed reply payload
      // here (the streaming happy-path never goes through deliverReplies, which
      // emits for the non-streaming/fallback paths). emitSlackMessageSentHooks
      // self-gates on registered listeners, so this is a no-op when unused.
      delivery.acknowledgeStoppedStreamedDeliveries(finalStream, stopResult?.messageId);
    } catch (err) {
      if (err instanceof SlackStreamNotDeliveredError) {
        streamFallbackDelivered = await delivery.deliverPendingStreamFallback(finalStream, err);
        if (!streamFallbackDelivered) {
          dispatchError ??= err;
        }
      } else {
        const error = formatSlackError(err);
        delivery.emitAcknowledgedStreamedDeliveries();
        delivery.emitFailedPendingStreamedDeliveries(error);
        runtime.error?.(danger(`slack-stream: failed to stop stream: ${error}`));
        if (!finalStream.delivered) {
          dispatchError ??= err;
        }
      }
    }
  }

  counts = delivery.reconcileCounts(counts);
  queuedFinal = queuedFinal && (counts.final ?? 0) > 0;

  const anyReplyDelivered = hasVisibleInboundReplyDispatch(
    { queuedFinal, counts },
    {
      observedReplyDelivery: delivery.observedReplyDelivery,
      fallbackDelivered: streamFallbackDelivered,
    },
  );

  if (pendingFailureNotice && anyReplyDelivered) {
    recordSlackThreadFailureNotice(pendingFailureNotice);
  }

  if (dispatchError || agentRunFailed) {
    await progress.finalizeDraftProgressCard("error");
  }
  await progress.dropDetachedProgressCards();

  if (statusReactionsEnabled) {
    if (dispatchError || agentRunFailed) {
      await statusReactions.setError();
      void statusReactions.restoreInitial();
    } else if (anyReplyDelivered) {
      await statusReactions.setDone();
      void statusReactions.restoreInitial();
    } else {
      // Silent success should preserve queued state and clear any stall timers
      // instead of transitioning to terminal/stall reactions after return.
      await statusReactions.restoreInitial();
    }
  }

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = delivery.usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs, {
      agentId: route.agentId,
      teamId: prepared.eventScope?.teamId,
    });
  }
  if (dispatchError) {
    throw toErrorObject(dispatchError, "Slack dispatch failed");
  }
  if (
    !anyReplyDelivered &&
    !draftPreviewCommitted.value &&
    !(agentRunFailed && progress.useDraftProgressCard)
  ) {
    await draftStream?.clear();
    await progress.dropDetachedProgressCards();
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }
}
