import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import { emitSlackMessageSentHooks } from "../../message-sent-hook.js";
import { resolveSlackReplyRenderPlan } from "../../reply-blocks.js";
import {
  appendSlackStream,
  markSlackStreamFallbackDelivered,
  SlackStreamNotDeliveredError,
  startSlackStream,
  stopSlackStream,
  type SlackStreamSession,
} from "../../streaming.js";
import { countSlackTextUtf8Bytes } from "../../truncate.js";
import {
  deliverReplies,
  readSlackReplyBlocks,
  resolveDeliveredSlackReplyThreadTs,
} from "../replies.js";
import {
  createSlackEventDeliveryTracker,
  resolveSlackStreamRecipientTeamId,
  type SlackEventDeliveryAttempt,
} from "./dispatch-helpers.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";

export function createSlackStreamingDeliveryRuntime(setup: SlackDispatchSetup) {
  const {
    account,
    ctx,
    forcedReplyThreadTs,
    isThreadReply,
    message,
    messageSentDeliveryHookContext,
    messageSentHookContext,
    messageSentHookTarget,
    prepared,
    replyDeliveryMode,
    replyPlan,
    runtime,
    slackClient,
    slackIdentity,
    slackMessageMetadata,
    slackStreamFallbackTeamId,
  } = setup;
  const state = {
    streamSession: null as SlackStreamSession | null,
    nativeProgressStreamStartPromise: null as Promise<SlackStreamSession | null> | null,
    nativeProgressStreamThreadTs: undefined as string | undefined,
    streamFailed: false,
    usedReplyThreadTs: undefined as string | undefined,
    usedBlockReplyThreadTs: undefined as string | undefined,
    observedReplyDelivery: false,
    observedFinalReplyDelivery: false,
  };
  // Reply payloads routed through the native text stream. Track Slack
  // acknowledgement separately because a later buffered suffix can fall back
  // after earlier payloads are already visible.
  const streamedDeliveries: Array<{
    kind: ReplyDispatchKind;
    content: string;
    acknowledged: boolean;
    outcome?: "success" | "failure";
  }> = [];
  const refreshStreamedAcknowledgements = (session: SlackStreamSession) => {
    if (session.pendingText.length === 0) {
      for (const delivery of streamedDeliveries) {
        delivery.acknowledged = true;
      }
    }
  };
  const recordStreamedDelivery = (kind: ReplyDispatchKind, content: string) => {
    const delivery: (typeof streamedDeliveries)[number] = {
      kind,
      content,
      acknowledged: false,
    };
    streamedDeliveries.push(delivery);
    return delivery;
  };
  const rememberStreamedDelivery = (
    kind: ReplyDispatchKind,
    content: string,
    session: SlackStreamSession,
  ) => {
    recordStreamedDelivery(kind, content);
    refreshStreamedAcknowledgements(session);
  };
  const emitAcknowledgedStreamedDeliveries = (messageId?: string) => {
    for (const delivery of streamedDeliveries) {
      if (!delivery.acknowledged || delivery.outcome) {
        continue;
      }
      emitSlackMessageSentHooks({
        ...messageSentHookContext,
        to: messageSentHookTarget,
        accountId: account.accountId,
        content: delivery.content,
        success: true,
        ...(messageId ? { messageId } : {}),
      });
      delivery.outcome = "success";
    }
  };
  const acknowledgeStoppedStreamedDeliveries = (
    session: SlackStreamSession,
    messageId?: string,
  ) => {
    refreshStreamedAcknowledgements(session);
    for (const delivery of streamedDeliveries) {
      delivery.acknowledged = true;
    }
    emitAcknowledgedStreamedDeliveries(messageId);
  };
  const emitFailedPendingStreamedDeliveries = (error: string) => {
    for (const delivery of streamedDeliveries) {
      if (delivery.acknowledged || delivery.outcome) {
        continue;
      }
      emitSlackMessageSentHooks({
        ...messageSentHookContext,
        to: messageSentHookTarget,
        accountId: account.accountId,
        content: delivery.content,
        success: false,
        error,
      });
      delivery.outcome = "failure";
    }
  };
  const emitSuccessfulPendingStreamedDeliveries = (messageId?: string) => {
    for (const delivery of streamedDeliveries) {
      if (delivery.acknowledged || delivery.outcome) {
        continue;
      }
      emitSlackMessageSentHooks({
        ...messageSentHookContext,
        to: messageSentHookTarget,
        accountId: account.accountId,
        content: delivery.content,
        success: true,
        ...(messageId ? { messageId } : {}),
      });
      delivery.outcome = "success";
    }
  };
  let deliveryTracker = createSlackEventDeliveryTracker();
  const markPreviewPayloadDelivered = (params: {
    kind: ReplyDispatchKind;
    payload: ReplyPayload;
    threadTs: string | undefined;
  }) => {
    deliveryTracker.markDelivered(params);
    // Single-use reply modes move later same-turn payloads off the preview
    // thread, so protect both delivery keys from duplicates.
    const nextThreadTs = replyPlan.peekThreadTs();
    if (nextThreadTs !== params.threadTs) {
      deliveryTracker.markDelivered({ ...params, threadTs: nextThreadTs });
    }
  };
  const resolveDeliveryThreadTs = (params: {
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): string | undefined => {
    const plannedThreadTs = params.forcedThreadTs ? undefined : replyPlan.nextThreadTs();
    return (
      params.forcedThreadTs ??
      plannedThreadTs ??
      (params.kind === "block" ? state.usedBlockReplyThreadTs : undefined)
    );
  };
  const rememberDeliveredThreadTs = (
    kind: ReplyDispatchKind,
    deliveredThreadTs: string | undefined,
  ) => {
    if (!deliveredThreadTs) {
      return;
    }
    state.usedReplyThreadTs ??= deliveredThreadTs;
    if (kind === "block") {
      state.usedBlockReplyThreadTs = deliveredThreadTs;
    }
  };
  const deliverPendingStreamFallback = async (
    session: SlackStreamSession,
    err: SlackStreamNotDeliveredError,
  ): Promise<boolean> => {
    let fallbackError = err;
    if (!session.stopped) {
      try {
        const stopResult = await stopSlackStream({
          session,
          ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        });
        acknowledgeStoppedStreamedDeliveries(session, stopResult.messageId);
        state.observedReplyDelivery = true;
        state.usedReplyThreadTs ??= session.threadTs;
        return true;
      } catch (stopErr) {
        if (stopErr instanceof SlackStreamNotDeliveredError) {
          fallbackError = stopErr;
        } else {
          runtime.error?.(
            danger(
              `slack-stream: failed to finalize buffered text before fallback: ${formatSlackError(stopErr)}`,
            ),
          );
        }
      }
    }
    emitAcknowledgedStreamedDeliveries();
    // The Slack SDK still owns this text in-memory; no streaming API call has
    // acknowledged it. Route through deliverReplies so pendingText that
    // exceeds Slack's per-message text limit still lands (a single
    // chat.postMessage would have failed with msg_too_long), and so the
    // fallback respects the configured replyToMode/identity the same way
    // normal replies do.
    const fallbackText = fallbackError.pendingText.trim();
    if (!fallbackText) {
      return false;
    }
    try {
      await deliverReplies({
        cfg: ctx.cfg,
        replies: [{ text: fallbackText } as ReplyPayload],
        target: prepared.replyTarget,
        token: ctx.botToken,
        accountId: account.accountId,
        runtime,
        textLimit: ctx.textLimit,
        mediaMaxBytes: ctx.mediaMaxBytes,
        replyThreadTs: session.threadTs,
        replyToMode: replyDeliveryMode,
        ...(slackIdentity ? { identity: slackIdentity } : {}),
        ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        ...messageSentDeliveryHookContext,
        deferMessageSentHooks: true,
        eventScope: prepared.eventScope,
      });
      markSlackStreamFallbackDelivered(session);
      if (!session.stopped) {
        try {
          await stopSlackStream({
            session,
            ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
          });
        } catch (finalizeErr) {
          runtime.error?.(
            danger(
              `slack-stream: failed to finalize native stream after fallback delivery: ${formatSlackError(finalizeErr)}`,
            ),
          );
        }
      }
      // The combined fallback can span multiple logical payloads and Slack
      // chunks, so no single message `ts` correctly identifies every event.
      emitSuccessfulPendingStreamedDeliveries();
      state.observedReplyDelivery = true;
      state.usedReplyThreadTs ??= session.threadTs;
      logVerbose(
        `slack-stream: streamed delivery failed (${fallbackError.slackCode}); delivered ${fallbackText.length} chars via deliverReplies fallback`,
      );
      return true;
    } catch (postErr) {
      emitFailedPendingStreamedDeliveries(formatErrorMessage(postErr));
      runtime.error?.(
        danger(
          `slack-stream: fallback deliverReplies failed after ${fallbackError.slackCode}: ${formatErrorMessage(postErr)}`,
        ),
      );
      return false;
    }
  };

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<string | undefined> => {
    const replyThreadTs = resolveDeliveryThreadTs(params);
    const deliveryReplyThreadTs =
      replyDeliveryMode === "off" && !forcedReplyThreadTs && !isThreadReply
        ? undefined
        : replyThreadTs;
    if (
      deliveryTracker.hasDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: deliveryReplyThreadTs,
      })
    ) {
      logVerbose("slack: suppressed duplicate normal delivery within the same turn");
      return deliveryReplyThreadTs;
    }
    await deliverReplies({
      cfg: ctx.cfg,
      replies: [params.payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      mediaMaxBytes: ctx.mediaMaxBytes,
      replyThreadTs: deliveryReplyThreadTs,
      replyToMode: replyDeliveryMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
      ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
      ...messageSentDeliveryHookContext,
      eventScope: prepared.eventScope,
    });
    state.observedReplyDelivery = true;
    if (params.kind === "final") {
      state.observedFinalReplyDelivery = true;
    }
    const deliveredThreadTs = resolveDeliveredSlackReplyThreadTs({
      replyToMode: replyDeliveryMode,
      payloadReplyToId: params.payload.replyToId,
      replyThreadTs: deliveryReplyThreadTs,
    });
    // Record the thread ts only after confirmed delivery success.
    rememberDeliveredThreadTs(params.kind, deliveredThreadTs);
    replyPlan.markSent();
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: deliveryReplyThreadTs,
    });
    return deliveryReplyThreadTs;
  };

  const deliverBufferedStreamFallback = async (params: {
    session: SlackStreamSession;
    err: SlackStreamNotDeliveredError;
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    textOverride: string;
  }): Promise<boolean> => {
    const delivered = await deliverPendingStreamFallback(params.session, params.err);
    if (!delivered) {
      return false;
    }
    replyPlan.markSent();
    if (params.kind === "final") {
      state.observedFinalReplyDelivery = true;
    }
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: params.session.threadTs,
      textOverride: params.textOverride,
    });
    rememberDeliveredThreadTs(params.kind, params.session.threadTs);
    return true;
  };

  const isStreamingEligible = (payload: ReplyPayload, options?: { maxTextBytes?: number }) => {
    const reply = resolveSendableOutboundReplyParts(payload);
    const renderPlan = resolveSlackReplyRenderPlan(payload);
    const plannedBlocks =
      renderPlan.mode === "single" ? renderPlan.blocks : renderPlan.blockPart?.blocks;
    return (
      !state.streamFailed &&
      !reply.hasMedia &&
      renderPlan.mode !== "split" &&
      !plannedBlocks?.length &&
      !readSlackReplyBlocks(payload)?.length &&
      reply.hasText &&
      (!options?.maxTextBytes || countSlackTextUtf8Bytes(reply.trimmedText) <= options.maxTextBytes)
    );
  };

  const deliverWithStreaming = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    streamText?: string;
    appendSeparator?: boolean;
    taskDisplayMode?: "plan" | "timeline";
  }): Promise<void> => {
    const reply = resolveSendableOutboundReplyParts(params.payload);
    if (!isStreamingEligible(params.payload)) {
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: state.streamSession?.threadTs ?? state.nativeProgressStreamThreadTs,
      });
      return;
    }

    const text = params.streamText ?? reply.trimmedText;
    const hookContent = reply.trimmedText;
    let plannedThreadTs: string | undefined;
    try {
      if (!state.streamSession && state.nativeProgressStreamStartPromise) {
        await state.nativeProgressStreamStartPromise;
      }
      if (state.streamFailed) {
        await deliverNormally({
          payload: params.payload,
          kind: params.kind,
          forcedThreadTs: state.streamSession?.threadTs ?? state.nativeProgressStreamThreadTs,
        });
        return;
      }
      if (!state.streamSession) {
        const streamThreadTs = replyPlan.nextThreadTs();
        plannedThreadTs = streamThreadTs;
        if (!streamThreadTs) {
          logVerbose(
            "slack-stream: no reply thread target for stream start, falling back to normal delivery",
          );
          state.streamFailed = true;
          await deliverNormally({
            payload: params.payload,
            kind: params.kind,
          });
          return;
        }
        if (
          deliveryTracker.hasDelivered({
            kind: params.kind,
            payload: params.payload,
            threadTs: streamThreadTs,
            textOverride: text,
          })
        ) {
          logVerbose("slack-stream: suppressed duplicate stream start payload");
          return;
        }

        state.streamSession = await startSlackStream({
          client: slackClient,
          channel: message.channel,
          threadTs: streamThreadTs,
          text,
          ...(params.taskDisplayMode ? { taskDisplayMode: params.taskDisplayMode } : {}),
          ...(slackIdentity ? { identity: slackIdentity } : {}),
          teamId: await resolveSlackStreamRecipientTeamId({
            client: slackClient,
            token: ctx.botToken,
            userId: message.user,
            fallbackTeamId: slackStreamFallbackTeamId,
          }),
          userId: message.user,
        });
        refreshStreamedAcknowledgements(state.streamSession);
        // startSlackStream may only buffer locally. Count delivery only after
        // the SDK reports a real Slack response.
        if (state.streamSession.delivered) {
          state.observedReplyDelivery = true;
          if (params.kind === "final") {
            state.observedFinalReplyDelivery = true;
          }
        }
        // Remember the reply text delivered through the text stream so the
        // `message_sent` hook can fire after stopSlackStream flushes it.
        // Only the text-stream path captures this; every deliverNormally branch
        // already emits via deliverReplies, so capturing there would
        // double-emit for the same payload.
        if (hookContent) {
          rememberStreamedDelivery(params.kind, hookContent, state.streamSession);
        }
        rememberDeliveredThreadTs(params.kind, streamThreadTs);
        replyPlan.markSent();
        deliveryTracker.markDelivered({
          kind: params.kind,
          payload: params.payload,
          threadTs: streamThreadTs,
          textOverride: text,
        });
        return;
      }
      if (
        deliveryTracker.hasDelivered({
          kind: params.kind,
          payload: params.payload,
          threadTs: state.streamSession.threadTs,
          textOverride: text,
        })
      ) {
        logVerbose("slack-stream: suppressed duplicate append payload");
        return;
      }

      if (hookContent) {
        // appendSlackStream buffers text before attempting the Slack flush.
        // Record first so a later successful stop can acknowledge a thrown append.
        recordStreamedDelivery(params.kind, hookContent);
      }
      await appendSlackStream({
        session: state.streamSession,
        text: `${params.appendSeparator === false ? "" : "\n"}${text}`,
      });
      refreshStreamedAcknowledgements(state.streamSession);
      // appendSlackStream also buffers locally below the SDK threshold; avoid
      // optimistic "done" status until Slack acknowledges a flush.
      if (state.streamSession.delivered && state.streamSession.pendingText.length === 0) {
        state.observedReplyDelivery = true;
        if (params.kind === "final") {
          state.observedFinalReplyDelivery = true;
        }
      }
      deliveryTracker.markDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: state.streamSession.threadTs,
        textOverride: text,
      });
    } catch (err) {
      if (err instanceof SlackStreamNotDeliveredError) {
        state.streamFailed = true;
        if (state.streamSession) {
          const delivered = await deliverBufferedStreamFallback({
            session: state.streamSession,
            err,
            payload: params.payload,
            kind: params.kind,
            textOverride: text,
          });
          if (delivered) {
            return;
          }
          throw err;
        }
        await deliverNormally({
          payload: params.payload,
          kind: params.kind,
          forcedThreadTs: plannedThreadTs,
        });
        return;
      }
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${formatSlackError(err)}, falling back`),
      );
      state.streamFailed = true;
      // Non-benign streaming errors leave `pendingText` populated with every
      // buffered chunk since the last flush (appendSlackStream accumulates
      // into pendingText BEFORE the SDK call, so the failing chunk is
      // included too). Route the full buffer through the chunked fallback so
      // earlier chunks aren't lost, then skip deliverNormally - pendingText
      // already contains this payload's text.
      if (state.streamSession && state.streamSession.pendingText) {
        const bufferedFallbackErr = new SlackStreamNotDeliveredError(
          state.streamSession.pendingText,
          "unknown",
        );
        const delivered = await deliverBufferedStreamFallback({
          session: state.streamSession,
          err: bufferedFallbackErr,
          payload: params.payload,
          kind: params.kind,
          textOverride: text,
        });
        if (delivered) {
          return;
        }
        throw err;
      }
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs:
          state.streamSession?.threadTs ?? state.nativeProgressStreamThreadTs ?? plannedThreadTs,
      });
    }
  };

  return Object.assign(state, {
    acknowledgeStoppedStreamedDeliveries,
    deliverNormally,
    deliverPendingStreamFallback,
    deliverWithStreaming,
    emitAcknowledgedStreamedDeliveries,
    emitFailedPendingStreamedDeliveries,
    hasDelivered: (params: SlackEventDeliveryAttempt) => deliveryTracker.hasDelivered(params),
    isStreamingEligible,
    markPreviewPayloadDelivered,
    rememberDeliveredThreadTs,
    resetDeliveryTracker: () => {
      deliveryTracker = createSlackEventDeliveryTracker();
    },
  });
}

export type SlackStreamingDeliveryRuntime = ReturnType<typeof createSlackStreamingDeliveryRuntime>;
