// Telegram plugin module owns final payload projection and Telegram delivery.
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import {
  createOutboundPayloadPlan,
  deriveDurableFinalDeliveryRequirements,
  projectOutboundPayloadPlanForDelivery,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramDraftController } from "./bot-message-dispatch-draft.js";
import type { TelegramProgressController } from "./bot-message-dispatch-progress.js";
import {
  mirrorTelegramAssistantReplyToTranscript,
  createCurrentTurnTranscriptFinalResolver,
} from "./bot-message-dispatch-session.js";
import type {
  CurrentTurnTranscriptFinal,
  FreshTelegramSessionEntryLoader,
  TelegramTranscriptMirrorPayload,
} from "./bot-message-dispatch.types.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { deliverReplies, emitInternalMessageSentHook } from "./bot/delivery.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import { resolveTelegramReplyId } from "./bot/helpers.js";
import type { TelegramNativeQuoteCandidateByMessageId } from "./bot/native-quote.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import {
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type LaneDeliveryResult,
} from "./lane-delivery.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import {
  createTelegramPromptContextProjectionSequence,
  resolveTelegramPromptContextDeliverySignature,
  withTelegramPromptContextSource,
  type TelegramPromptContextProjection,
  type TelegramPromptContextProjectionSequence,
  type TelegramPromptContextSource,
} from "./prompt-context-projection.js";
import { editMessageTelegram } from "./send.js";
import { resolveTelegramTargetChatType } from "./targets.js";

export function createTelegramDeliveryController(params: {
  bot: Bot;
  cfg: OpenClawConfig;
  chunkMode: ReturnType<typeof import("./bot-message-dispatch.runtime.js").resolveChunkMode>;
  context: TelegramMessageContext;
  dispatchStartedAt: number;
  draft: TelegramDraftController;
  isDispatchSuperseded: () => boolean;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  mediaLocalRoots: readonly string[];
  opts: Pick<TelegramBotOptions, "token" | "mediaMaxMb">;
  progress: TelegramProgressController;
  draftReplyToMessageId?: number;
  replyQuoteByMessageId: TelegramNativeQuoteCandidateByMessageId;
  replyQuoteEntities?: Message["entities"];
  replyQuoteMessageId?: number;
  replyQuotePosition?: number;
  replyQuoteText?: string;
  replyToMode: ReplyToMode;
  runtime: RuntimeEnv;
  streamMode: import("./bot/types.js").TelegramStreamMode;
  tableMode: Parameters<typeof deliverReplies>[0]["tableMode"];
  telegramCfg: TelegramAccountConfig;
  telegramDeps: TelegramBotDeps;
  textLimit: number;
  threadSpec: TelegramThreadSpec;
}) {
  const { context } = params;
  const sessionKey = context.ctxPayload.SessionKey;
  const deliveryState = createLaneDeliveryStateTracker();
  const resolveCurrentTurnTranscriptFinal = createCurrentTurnTranscriptFinalResolver({
    agentId: context.route.agentId,
    dispatchStartedAt: params.dispatchStartedAt,
    loadFreshSessionEntry: params.loadFreshSessionEntry,
    sessionKey,
  });
  let transcriptMirrorSequence = 0;
  const transcriptMirrorTurnId = `${context.chatId}:${context.ctxPayload.MessageSid ?? context.msg.message_id ?? params.dispatchStartedAt}`;
  const implicitQuoteReplyTargetId =
    context.ctxPayload.ReplyToIsQuote &&
    !context.msg.reply_to_message?.from?.is_bot &&
    params.replyQuoteMessageId != null
      ? String(params.replyQuoteMessageId)
      : undefined;
  const currentMessageIdForQuoteReply =
    implicitQuoteReplyTargetId && context.ctxPayload.MessageSid
      ? context.ctxPayload.MessageSid
      : undefined;

  const projectPayloadForDelivery = (payload: ReplyPayload): ReplyPayload | undefined =>
    projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([payload], {
        cfg: params.cfg,
        sessionKey,
        surface: "telegram",
      }),
    )[0];
  const promptContextDeliverySignature = (payload: ReplyPayload): string | undefined => {
    const projected = projectPayloadForDelivery(payload);
    return projected ? resolveTelegramPromptContextDeliverySignature(projected) : undefined;
  };
  const resolvePromptContextSource = (
    final: CurrentTurnTranscriptFinal | undefined,
    ...payloads: ReplyPayload[]
  ): TelegramPromptContextSource | undefined => {
    const finalSignature = final ? promptContextDeliverySignature({ text: final.text }) : undefined;
    if (!final?.messageId || !finalSignature) {
      return undefined;
    }
    return payloads.some((payload) => promptContextDeliverySignature(payload) === finalSignature)
      ? { transcriptMessageId: final.messageId }
      : undefined;
  };
  const recordPromptContextMessage = (record: {
    messageId: number;
    message?: Message;
    text?: string;
    projection?: TelegramPromptContextProjection;
  }): Promise<boolean> =>
    (
      params.telegramDeps.recordOutboundMessageForPromptContext ??
      recordOutboundMessageForPromptContext
    )({
      cfg: params.cfg,
      account: {
        accountId: context.route.accountId,
        ...(params.telegramCfg.name !== undefined ? { name: params.telegramCfg.name } : {}),
        ...(context.primaryCtx.me ? { bot: context.primaryCtx.me } : {}),
      },
      ...(context.primaryCtx.me?.id !== undefined ? { botUserId: context.primaryCtx.me.id } : {}),
      chatId: String(context.chatId),
      message: record.message ?? { message_id: record.messageId },
      messageId: record.messageId,
      ...(record.text ? { text: record.text } : {}),
      ...(record.projection ? { promptContextProjection: record.projection } : {}),
      ...(params.threadSpec.id !== undefined ? { messageThreadId: params.threadSpec.id } : {}),
      successfulSendThread: params.threadSpec,
    });
  const createPromptContextSequence = (source?: TelegramPromptContextSource) =>
    createTelegramPromptContextProjectionSequence({
      ...(source ? { source } : {}),
      record: recordPromptContextMessage,
    });
  const transcriptMirror = sessionKey
    ? async (payload: TelegramTranscriptMirrorPayload) => {
        const idempotencyKey = `telegram-final:${sessionKey}:${transcriptMirrorTurnId}:${transcriptMirrorSequence++}`;
        await mirrorTelegramAssistantReplyToTranscript({
          cfg: params.cfg,
          idempotencyKey,
          loadFreshSessionEntry: params.loadFreshSessionEntry,
          route: context.route,
          sessionKey,
          payload,
        });
      }
    : undefined;
  const deliveryBaseOptions = {
    cfg: params.cfg,
    chatId: String(context.chatId),
    accountId: context.route.accountId,
    sessionKeyForInternalHooks: sessionKey,
    mirrorIsGroup: context.isGroup,
    mirrorGroupId: context.isGroup ? String(context.chatId) : undefined,
    token: params.opts.token,
    runtime: params.runtime,
    bot: params.bot,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaMaxBytes: (params.opts.mediaMaxMb ?? params.telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024,
    replyToMode: params.replyToMode,
    textLimit: params.textLimit,
    thread: params.threadSpec,
    tableMode: params.tableMode,
    chunkMode: params.chunkMode,
    richMessages: params.telegramCfg.richMessages,
    linkPreview: params.telegramCfg.linkPreview,
    replyQuoteMessageId: params.replyQuoteMessageId,
    replyQuoteText: params.replyQuoteText,
    replyQuotePosition: params.replyQuotePosition,
    replyQuoteEntities: params.replyQuoteEntities,
    replyQuoteByMessageId: params.replyQuoteByMessageId,
    transcriptMirror,
  };

  const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload =>
    payload.text === text ? payload : { ...payload, text };
  const applyQuoteReplyTarget = (payload: ReplyPayload): ReplyPayload => {
    if (
      !implicitQuoteReplyTargetId ||
      !currentMessageIdForQuoteReply ||
      payload.replyToId !== currentMessageIdForQuoteReply ||
      payload.replyToTag ||
      payload.replyToCurrent
    ) {
      return payload;
    }
    return { ...payload, replyToId: implicitQuoteReplyTargetId };
  };
  const usesNativeTelegramQuote = (payload: ReplyPayload): boolean =>
    params.replyQuoteText != null ||
    (payload.replyToId != null && params.replyQuoteByMessageId[payload.replyToId] != null);

  const sendPayload = async (
    payload: ReplyPayload,
    options?: {
      afterAcceptedDraft?: boolean;
      durable?: boolean;
      silent?: boolean;
      mirrorTranscript?: boolean;
      promptContextSequence?: TelegramPromptContextProjectionSequence;
      textMode?: "html";
    },
  ) => {
    if (params.isDispatchSuperseded()) {
      await options?.promptContextSequence?.fail();
      return false;
    }
    const targetedPayload = applyQuoteReplyTarget(payload);
    const finalReplyTargetId = resolveTelegramReplyId(targetedPayload.replyToId);
    const targetsDifferentMessage =
      finalReplyTargetId != null && finalReplyTargetId !== params.draftReplyToMessageId;
    const consumedSingleUseReply =
      options?.afterAcceptedDraft === true &&
      isSingleUseReplyToMode(params.replyToMode) &&
      !targetsDifferentMessage;
    const deliverablePayload = consumedSingleUseReply
      ? (({ replyToId: _, replyToTag: _tag, replyToCurrent: _current, ...rest }) => rest)(
          targetedPayload,
        )
      : targetedPayload;
    const effectiveReplyToMode = consumedSingleUseReply ? "off" : params.replyToMode;
    const projectionSequence =
      options?.promptContextSequence ??
      createPromptContextSequence(
        options?.durable
          ? resolvePromptContextSource(
              await resolveCurrentTurnTranscriptFinal(),
              deliverablePayload,
            )
          : undefined,
      );
    const effectivePayload = withTelegramPromptContextSource(
      deliverablePayload,
      projectionSequence.source,
    );
    const silent =
      options?.silent ??
      (params.telegramCfg.silentErrorReplies === true && payload.isError === true);
    const durableDelivery = params.telegramDeps.deliverInboundReplyWithMessageSendContext;
    if (options?.durable && durableDelivery && projectionSequence.isFresh()) {
      const durable = await durableDelivery({
        cfg: params.cfg,
        channel: "telegram",
        to: String(context.chatId),
        accountId: context.route.accountId,
        agentId: context.route.agentId,
        ctxPayload: context.ctxPayload,
        payload: effectivePayload,
        info: { kind: "final" },
        replyToMode: effectiveReplyToMode,
        threadId: params.threadSpec.id,
        formatting: {
          textLimit: params.textLimit,
          tableMode: params.tableMode,
          chunkMode: params.chunkMode,
          ...(options?.textMode === "html" ? { parseMode: "HTML" as const } : {}),
        },
        silent,
        requiredCapabilities: deriveDurableFinalDeliveryRequirements({
          payload: effectivePayload,
          replyToId: effectivePayload.replyToId,
          threadId: params.threadSpec.id,
          silent,
          payloadTransport: true,
          extraCapabilities: {
            nativeQuote: !consumedSingleUseReply && usesNativeTelegramQuote(effectivePayload),
          },
        }),
      });
      if (durable.status === "failed") {
        await projectionSequence.fail();
        throw durable.error;
      }
      if (durable.status === "handled_visible") {
        deliveryState.markDelivered();
        return true;
      }
      if (durable.status === "handled_no_send") {
        await projectionSequence.fail();
        return false;
      }
    }
    try {
      const result = await (params.telegramDeps.deliverReplies ?? deliverReplies)({
        ...deliveryBaseOptions,
        replyToMode: effectiveReplyToMode,
        transcriptMirror:
          options?.durable && options?.mirrorTranscript !== false ? transcriptMirror : undefined,
        replies: [effectivePayload],
        onVoiceRecording: context.sendRecordVoice,
        silent,
        mediaLoader: params.telegramDeps.loadWebMedia,
        promptContextSequence: projectionSequence,
        ...(options?.textMode ? { textMode: options.textMode } : {}),
      });
      if (!result.delivered) {
        await projectionSequence.fail();
        return false;
      }
      await projectionSequence.finish();
      deliveryState.markDelivered();
      return true;
    } catch (error) {
      await projectionSequence.fail();
      throw error;
    }
  };

  const emitPreviewFinalizedHook = async (result: LaneDeliveryResult) => {
    if (params.isDispatchSuperseded() || result.kind !== "preview-finalized") {
      return;
    }
    (params.telegramDeps.emitInternalMessageSentHook ?? emitInternalMessageSentHook)({
      sessionKeyForInternalHooks: sessionKey,
      chatId: String(context.chatId),
      accountId: context.route.accountId,
      content: result.delivery.content,
      success: true,
      messageId: result.delivery.messageId,
      isGroup: context.isGroup,
      groupId: context.isGroup ? String(context.chatId) : undefined,
    });
    if (transcriptMirror && result.delivery.content) {
      void transcriptMirror({ text: result.delivery.content }).catch((err: unknown) => {
        logVerbose(
          `telegram preview-finalized transcriptMirror failed: ${formatErrorMessage(err)}`,
        );
      });
    }
  };
  const deliverLaneText = createLaneTextDeliverer({
    lanes: params.draft.lanes,
    applyTextToPayload,
    sendPayload,
    flushDraftLane: params.draft.flushLane,
    stopDraftLane: async (lane) => await lane.stream?.stop(),
    clearDraftLane: async (lane) => await lane.stream?.clear(),
    editStreamMessage: async ({ messageId, text, textMode, buttons }) => {
      if (!params.isDispatchSuperseded()) {
        await (params.telegramDeps.editMessageTelegram ?? editMessageTelegram)(
          context.chatId,
          messageId,
          text,
          {
            api: params.bot.api,
            cfg: params.cfg,
            accountId: context.route.accountId,
            linkPreview: params.telegramCfg.linkPreview,
            textMode,
            buttons,
          },
        );
      }
    },
    createPromptContextSequence,
    resolveFinalTextCandidate: async () => (await resolveCurrentTurnTranscriptFinal())?.text,
    log: logVerbose,
    markDelivered: deliveryState.markDelivered,
  });

  const materializeAnswerLaneBeforeRotation = async () => {
    const block = params.draft.activeAnswerBlockDelivery();
    const lane = params.draft.answerLane;
    if (
      !block ||
      !lane.stream ||
      !lane.hasStreamedMessage ||
      lane.finalized ||
      params.draft.isAnswerToolProgressOnly()
    ) {
      return;
    }
    const text = lane.lastPartialText || params.draft.lastAnswerPartialText() || block.text;
    if (!text?.trim()) {
      return;
    }
    const result = await deliverLaneText({
      laneName: "answer",
      text,
      payload: block.payload,
      infoKind: "block",
      buttons: block.buttons,
      finalizePreview: true,
      durable: false,
    });
    params.draft.setActiveAnswerBlockDelivery();
    await emitPreviewFinalizedHook(result);
  };
  params.draft.setMaterializeBeforeRotation(materializeAnswerLaneBeforeRotation);

  const postCosmeticSummaryBar = async (line: string) => {
    try {
      await sendPayload({ text: line }, { durable: true, mirrorTranscript: false });
    } catch (err) {
      logVerbose(`telegram: collapse summary bar send failed: ${formatErrorMessage(err)}`);
    }
  };
  const deliverProgressCollapseSummary = async () => {
    const line = params.progress.resolveCollapseSummaryLine();
    if (line) {
      await postCosmeticSummaryBar(line);
    }
  };
  const deliverProgressModeFinalAnswer = async (
    payload: ReplyPayload,
    text: string,
    promptContextSequence: TelegramPromptContextProjectionSequence,
  ): Promise<LaneDeliveryResult> => {
    const afterAcceptedDraft = params.draft.answerLane.stream?.hasConsumedReplyTarget?.() === true;
    if (payload.isError === true) {
      params.progress.setSummaryDelivered();
      await params.progress.teardownWindow();
      const delivered = await sendPayload(applyTextToPayload(payload, text), {
        afterAcceptedDraft,
        durable: true,
        promptContextSequence,
      });
      if (!delivered) {
        return { kind: "skipped" };
      }
      params.draft.answerLane.finalized = true;
      params.progress.markFinalDelivered();
      return { kind: "sent" };
    }
    const barLine = params.progress.resolveCollapseSummaryLine();
    const delivered = await sendPayload(applyTextToPayload(payload, text), {
      afterAcceptedDraft,
      durable: true,
      promptContextSequence,
    });
    if (barLine) {
      await params.progress.applyCollapseSummary(barLine, postCosmeticSummaryBar);
      params.progress.resetAnswerLaneAfterCollapse();
    } else {
      await params.progress.teardownWindow();
    }
    if (!delivered) {
      return { kind: "skipped" };
    }
    params.draft.answerLane.finalized = true;
    params.progress.markFinalDelivered();
    return { kind: "sent" };
  };
  const deliverFinalAnswerText = async (
    answerPayload: ReplyPayload,
    text: string,
    buttons?: TelegramInlineButtons,
  ): Promise<LaneDeliveryResult> => {
    const transcriptFinal = await resolveCurrentTurnTranscriptFinal();
    const finalText = await resolveTranscriptBackedChannelFinalText({
      finalText: text,
      resolveCandidateText: async () => transcriptFinal?.text,
    });
    const source = resolvePromptContextSource(
      transcriptFinal,
      answerPayload,
      applyTextToPayload(answerPayload, finalText),
    );
    const promptContextSequence = createPromptContextSequence(source);
    const isFollowUp = params.progress.finalAnswerDelivered();
    let result: LaneDeliveryResult;
    if (!isFollowUp && params.streamMode === "progress") {
      result = await deliverProgressModeFinalAnswer(
        answerPayload,
        finalText,
        promptContextSequence,
      );
    } else {
      if (isFollowUp) {
        await params.draft.prepareAnswerLaneForText();
      } else if (!(await params.draft.rotateAnswerLaneAfterToolProgress())) {
        await params.draft.rotateAnswerLaneAfterQueuedBlocksSettle();
      }
      result = await deliverLaneText({
        laneName: "answer",
        text: finalText,
        payload: answerPayload,
        infoKind: "final",
        buttons,
        allowStream: !usesNativeTelegramQuote(answerPayload),
        promptContextSequence,
      });
      if (!isFollowUp && result.kind !== "skipped") {
        params.progress.markFinalDelivered();
      }
    }
    if (result.kind === "preview-finalized") {
      await emitPreviewFinalizedHook(result);
    }
    return result;
  };
  const finalizePendingAnswerBlockDraft = async (final: {
    queuedFinal: boolean;
    dispatchError?: unknown;
  }) => {
    const block = params.draft.activeAnswerBlockDelivery();
    if (
      !block ||
      final.queuedFinal ||
      final.dispatchError ||
      params.isDispatchSuperseded() ||
      params.draft.answerLane.finalized
    ) {
      return;
    }
    const content = block.text.trimEnd();
    if (!content) {
      return;
    }
    params.progress.markFinalStarted();
    await deliverFinalAnswerText(block.payload, content, block.buttons);
    params.draft.setActiveAnswerBlockDelivery();
  };

  return {
    applyTextToPayload,
    createPromptContextSequence,
    deliverFallback: async (replies: ReplyPayload[], silent: boolean) =>
      await (params.telegramDeps.deliverReplies ?? deliverReplies)({
        replies,
        ...deliveryBaseOptions,
        silent,
        mediaLoader: params.telegramDeps.loadWebMedia,
      }),
    deliverFinalAnswerText,
    deliverLaneText,
    deliverProgressCollapseSummary,
    emitPreviewFinalizedHook,
    finalizePendingAnswerBlockDraft,
    markDelivered: deliveryState.markDelivered,
    markNonSilentFailure: deliveryState.markNonSilentFailure,
    markNonSilentSkip: deliveryState.markNonSilentSkip,
    normalizeDeliveryPayload: (payload: ReplyPayload): ReplyPayload | undefined => {
      const keepReasoningLane =
        payload.isReasoning === true && params.draft.durableReasoningPayloadsEnabled;
      const payloadForPlan = keepReasoningLane ? { ...payload } : payload;
      if (keepReasoningLane) {
        delete payloadForPlan.isReasoning;
      }
      const normalized = projectPayloadForDelivery(payloadForPlan);
      return normalized
        ? canonicalizeTelegramPresentationPayload(normalized, {
            allowWebAppButtons: resolveTelegramTargetChatType(String(context.chatId)) === "direct",
          })
        : undefined;
    },
    sendPayload,
    snapshot: deliveryState.snapshot,
  };
}

export type TelegramDeliveryController = ReturnType<typeof createTelegramDeliveryController>;
