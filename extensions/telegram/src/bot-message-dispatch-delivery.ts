import type { Message } from "grammy/types";
import {
  createOutboundPayloadPlan,
  deriveDurableFinalDeliveryRequirements,
  projectOutboundPayloadPlanForDelivery,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  flushDraftLane,
  prepareAnswerLaneForText,
  rotateAnswerLaneAfterQueuedBlocksSettle,
  rotateAnswerLaneAfterToolProgress,
} from "./bot-message-dispatch-draft.js";
import {
  markFinalDelivered,
  markFinalStarted,
  teardownProgressWindow,
} from "./bot-message-dispatch-progress.js";
import {
  createCurrentTurnTranscriptFinalResolver,
  mirrorTelegramAssistantReplyToTranscript,
} from "./bot-message-dispatch-session.js";
import type {
  TelegramDispatchTurn as Turn,
  TelegramDispatchTurnConfig as TurnConfig,
  CurrentTurnTranscriptFinal,
  TelegramDeliveryStateSlice,
  TelegramTranscriptMirrorPayload,
} from "./bot-message-dispatch.types.js";
import { deliverReplies, emitTelegramMessageSentHooks } from "./bot/delivery.js";
import { resolveTelegramReplyId } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { mergeTelegramPartialDeliveryError } from "./chunk-delivery.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import {
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
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
import { registerTelegramQuestionDelivery } from "./question-finalization.js";
import { editMessageReplyMarkupTelegram, editMessageTelegram } from "./send.js";
import { resolveTelegramTargetChatType } from "./targets.js";

type TelegramDeliveryConfig = TurnConfig & {
  lanes: Record<LaneName, DraftLaneState>;
};

type TelegramSendPayloadOptions = {
  afterAcceptedDraft?: boolean;
  durable?: boolean;
  silent?: boolean;
  mirrorTranscript?: boolean;
  promptContextSequence?: TelegramPromptContextProjectionSequence;
  textMode?: "html";
  onPlatformSendDispatch?: () => Promise<void>;
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
};

const projectPayloadForDelivery = (turn: Turn, payload: ReplyPayload): ReplyPayload | undefined =>
  projectOutboundPayloadPlanForDelivery(
    createOutboundPayloadPlan([payload], {
      cfg: turn.cfg,
      sessionKey: turn.context.ctxPayload.SessionKey,
      surface: "telegram",
    }),
  )[0];

const promptContextDeliverySignature = (turn: Turn, payload: ReplyPayload): string | undefined => {
  const projected = projectPayloadForDelivery(turn, payload);
  return projected ? resolveTelegramPromptContextDeliverySignature(projected) : undefined;
};

function resolvePromptContextSource(
  turn: Turn,
  final: CurrentTurnTranscriptFinal | undefined,
  ...payloads: ReplyPayload[]
): TelegramPromptContextSource | undefined {
  const finalSignature = final
    ? promptContextDeliverySignature(turn, { text: final.text })
    : undefined;
  if (!final?.messageId || !finalSignature) {
    return undefined;
  }
  return payloads.some(
    (payload) => promptContextDeliverySignature(turn, payload) === finalSignature,
  )
    ? { transcriptMessageId: final.messageId }
    : undefined;
}

async function recordPromptContextMessage(
  turn: Turn,
  record: {
    messageId: number;
    message?: Message;
    text?: string;
    projection?: TelegramPromptContextProjection;
  },
): Promise<boolean> {
  const { context } = turn;
  return await (
    turn.telegramDeps.recordOutboundMessageForPromptContext ?? recordOutboundMessageForPromptContext
  )({
    cfg: turn.cfg,
    ownerAgentId: turn.opts.ownerAgentId,
    account: {
      accountId: context.route.accountId,
      ...(turn.telegramCfg.name !== undefined ? { name: turn.telegramCfg.name } : {}),
      ...(context.primaryCtx.me ? { bot: context.primaryCtx.me } : {}),
    },
    ...(context.primaryCtx.me?.id !== undefined ? { botUserId: context.primaryCtx.me.id } : {}),
    chatId: String(context.chatId),
    message: record.message ?? { message_id: record.messageId },
    messageId: record.messageId,
    ...(record.text ? { text: record.text } : {}),
    ...(record.projection ? { promptContextProjection: record.projection } : {}),
    ...(turn.context.threadSpec.id !== undefined
      ? { messageThreadId: turn.context.threadSpec.id }
      : {}),
    successfulSendThread: turn.context.threadSpec,
  });
}

const createPromptContextSequence = (
  turn: Turn,
  source?: TelegramPromptContextSource,
): TelegramPromptContextProjectionSequence =>
  createTelegramPromptContextProjectionSequence({
    ...(source ? { source } : {}),
    record: async (record) => await recordPromptContextMessage(turn, record),
  });

function createTranscriptMirror(turn: Turn) {
  const sessionKey = turn.context.ctxPayload.SessionKey;
  return sessionKey
    ? async (payload: TelegramTranscriptMirrorPayload) => {
        const idempotencyKey = `telegram-final:${sessionKey}:${turn.transcriptMirrorTurnId}:${turn.transcriptMirrorSequence++}`;
        await mirrorTelegramAssistantReplyToTranscript({
          cfg: turn.cfg,
          idempotencyKey,
          loadFreshSessionEntry: turn.loadFreshSessionEntry,
          route: turn.context.route,
          sessionKey,
          payload,
        });
      }
    : undefined;
}

function createDeliveryBaseOptions(turn: Turn) {
  const { context } = turn;
  return {
    cfg: turn.cfg,
    ownerAgentId: turn.opts.ownerAgentId,
    chatId: String(context.chatId),
    accountId: context.route.accountId,
    sessionKeyForInternalHooks: context.ctxPayload.SessionKey,
    mirrorIsGroup: context.isGroup,
    mirrorGroupId: context.isGroup ? String(context.chatId) : undefined,
    token: turn.opts.token,
    runtime: turn.runtime,
    bot: turn.bot,
    mediaLocalRoots: turn.mediaLocalRoots,
    mediaMaxBytes: (turn.opts.mediaMaxMb ?? turn.telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024,
    replyToMode: turn.replyToMode,
    textLimit: turn.textLimit,
    thread: turn.context.threadSpec,
    tableMode: turn.tableMode,
    chunkMode: turn.chunkMode,
    richMessages: turn.telegramCfg.richMessages,
    linkPreview: turn.telegramCfg.linkPreview,
    replyQuoteMessageId: turn.replyQuoteMessageId,
    replyQuoteText: turn.replyQuoteText,
    replyQuotePosition: turn.replyQuotePosition,
    replyQuoteEntities: turn.replyQuoteEntities,
    replyQuoteByMessageId: turn.replyQuoteByMessageId,
    transcriptMirror: createTranscriptMirror(turn),
  };
}

export const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload =>
  payload.text === text ? payload : { ...payload, text };

function applyQuoteReplyTarget(turn: Turn, payload: ReplyPayload): ReplyPayload {
  if (
    !turn.implicitQuoteReplyTargetId ||
    !turn.currentMessageIdForQuoteReply ||
    payload.replyToId !== turn.currentMessageIdForQuoteReply ||
    payload.replyToTag ||
    payload.replyToCurrent
  ) {
    return payload;
  }
  return { ...payload, replyToId: turn.implicitQuoteReplyTargetId };
}

const usesNativeTelegramQuote = (turn: Turn, payload: ReplyPayload): boolean =>
  turn.replyQuoteText != null ||
  (payload.replyToId != null && turn.replyQuoteByMessageId[payload.replyToId] != null);

export async function sendPayload(
  turn: Turn,
  payload: ReplyPayload,
  options?: TelegramSendPayloadOptions,
): Promise<boolean> {
  if (turn.isSuperseded()) {
    await options?.promptContextSequence?.fail();
    return false;
  }
  const targetedPayload = applyQuoteReplyTarget(turn, payload);
  const finalReplyTargetId = resolveTelegramReplyId(targetedPayload.replyToId);
  const targetsDifferentMessage =
    finalReplyTargetId != null && finalReplyTargetId !== turn.draftReplyToMessageId;
  const consumedSingleUseReply =
    options?.afterAcceptedDraft === true &&
    isSingleUseReplyToMode(turn.replyToMode) &&
    !targetsDifferentMessage;
  const deliverablePayload = consumedSingleUseReply
    ? (({ replyToId: _, replyToTag: _tag, replyToCurrent: _current, ...rest }) => rest)(
        targetedPayload,
      )
    : targetedPayload;
  const effectiveReplyToMode = consumedSingleUseReply ? "off" : turn.replyToMode;
  const projectionSequence =
    options?.promptContextSequence ??
    createPromptContextSequence(
      turn,
      options?.durable
        ? resolvePromptContextSource(
            turn,
            await turn.resolveCurrentTurnTranscriptFinal(),
            deliverablePayload,
          )
        : undefined,
    );
  const projectedPayload = withTelegramPromptContextSource(
    deliverablePayload,
    projectionSequence.source,
  );
  const effectivePayload = options?.bindPendingFinalDelivery
    ? options.bindPendingFinalDelivery(projectedPayload)
    : projectedPayload;
  const silent =
    options?.silent ?? (turn.telegramCfg.silentErrorReplies === true && payload.isError === true);
  const durableDelivery = turn.telegramDeps.deliverInboundReplyWithMessageSendContext;
  if (options?.durable && durableDelivery && projectionSequence.isFresh()) {
    const durable = await durableDelivery({
      cfg: turn.cfg,
      channel: "telegram",
      to:
        turn.context.ctxPayload.OriginatingTo ??
        turn.context.ctxPayload.To ??
        `telegram:${turn.context.chatId}`,
      accountId: turn.context.route.accountId,
      agentId: turn.context.route.agentId,
      ctxPayload: turn.context.ctxPayload,
      payload: effectivePayload,
      info: { kind: "final" },
      replyToMode: effectiveReplyToMode,
      threadId: turn.context.threadSpec.id,
      formatting: {
        textLimit: turn.textLimit,
        tableMode: turn.tableMode,
        chunkMode: turn.chunkMode,
        ...(options?.textMode === "html" ? { parseMode: "HTML" as const } : {}),
      },
      silent,
      requiredCapabilities: deriveDurableFinalDeliveryRequirements({
        payload: effectivePayload,
        replyToId: effectivePayload.replyToId,
        threadId: turn.context.threadSpec.id,
        silent,
        payloadTransport: true,
        extraCapabilities: {
          nativeQuote: !consumedSingleUseReply && usesNativeTelegramQuote(turn, effectivePayload),
        },
      }),
    });
    if (durable.status === "failed") {
      await projectionSequence.fail();
      throw durable.error;
    }
    if (durable.status === "handled_visible") {
      turn.deliveryState.markDelivered();
      return true;
    }
    if (durable.status === "handled_no_send") {
      await projectionSequence.fail();
      return false;
    }
  }
  try {
    const transcriptMirror = createTranscriptMirror(turn);
    const result = await (turn.telegramDeps.deliverReplies ?? deliverReplies)({
      ...createDeliveryBaseOptions(turn),
      replyToMode: effectiveReplyToMode,
      transcriptMirror:
        options?.durable && options?.mirrorTranscript !== false ? transcriptMirror : undefined,
      replies: [effectivePayload],
      onVoiceRecording: turn.context.sendRecordVoice,
      silent,
      mediaLoader: turn.telegramDeps.loadWebMedia,
      promptContextSequence: projectionSequence,
      onPlatformSendDispatch: options?.onPlatformSendDispatch,
      ...(options?.textMode ? { textMode: options.textMode } : {}),
    });
    if (!result.delivered) {
      await projectionSequence.fail();
      return false;
    }
    await projectionSequence.finish();
    turn.deliveryState.markDelivered();
    return true;
  } catch (error) {
    await projectionSequence.fail();
    throw error;
  }
}

export async function emitPreviewFinalizedHook(
  turn: Turn,
  result: LaneDeliveryResult,
): Promise<void> {
  if (
    turn.isSuperseded() ||
    (result.kind !== "preview-finalized" && result.kind !== "preview-finalized-partial")
  ) {
    return;
  }
  // A finalized preview is the durable Telegram message. Emit the composite
  // terminal here so plugin and internal observers see that one provider result.
  (turn.telegramDeps.emitTelegramMessageSentHooks ?? emitTelegramMessageSentHooks)({
    sessionKeyForInternalHooks: turn.context.ctxPayload.SessionKey,
    chatId: String(turn.context.chatId),
    accountId: turn.context.route.accountId,
    content: result.delivery.content,
    success: result.kind === "preview-finalized",
    messageId: result.delivery.messageId,
    isGroup: turn.context.isGroup,
    groupId: turn.context.isGroup ? String(turn.context.chatId) : undefined,
  });
  const transcriptMirror = createTranscriptMirror(turn);
  if (transcriptMirror && result.delivery.content) {
    void transcriptMirror({ text: result.delivery.content }).catch((err: unknown) => {
      logVerbose(`telegram preview-finalized transcriptMirror failed: ${formatErrorMessage(err)}`);
    });
  }
}

export function registerTelegramQuestionDeliveryForMessage(
  turn: Turn,
  payload: ReplyPayload,
  delivery: { messageId: number; text: string },
): void {
  const { chatId } = turn.context;
  const accountId = turn.context.route.accountId;
  const api = turn.bot.api;
  const cfg = turn.cfg;
  const linkPreview = turn.telegramCfg.linkPreview;
  const editText = turn.telegramDeps.editMessageTelegram ?? editMessageTelegram;
  const { messageId, text } = delivery;
  registerTelegramQuestionDelivery({
    accountId,
    chatId: String(chatId),
    messageId,
    payload,
    text,
    textLimit: turn.textLimit,
    clearButtons: async () => {
      await editMessageReplyMarkupTelegram(chatId, messageId, [], { api, cfg, accountId });
    },
    annotate: async (finalText) => {
      await editText(chatId, messageId, finalText, { api, cfg, accountId, linkPreview });
    },
  });
}

async function materializeAnswerLaneBeforeRotation(turn: Turn): Promise<void> {
  const block = turn.activeAnswerBlockDelivery;
  const lane = turn.answerLane;
  if (
    !block ||
    !lane.stream ||
    !lane.hasStreamedMessage ||
    lane.finalized ||
    turn.activeAnswerDraftIsToolProgressOnly
  ) {
    return;
  }
  const text = lane.lastPartialText || turn.lastAnswerPartialText || block.text;
  if (!text?.trim()) {
    return;
  }
  const result = await turn.deliverLaneText({
    laneName: "answer",
    text,
    payload: block.payload,
    infoKind: "block",
    buttons: block.buttons,
    finalizePreview: true,
    durable: false,
  });
  turn.activeAnswerBlockDelivery = undefined;
  await emitPreviewFinalizedHook(turn, result);
}

async function deliverTelegramProgressModeFinalAnswer(
  turn: Turn,
  payload: ReplyPayload,
  text: string,
  promptContextSequence: TelegramPromptContextProjectionSequence,
  onPlatformSendDispatch?: () => Promise<void>,
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T,
): Promise<LaneDeliveryResult> {
  const afterAcceptedDraft = turn.answerLane.stream?.hasConsumedReplyTarget?.() === true;
  if (payload.isError === true) {
    await teardownProgressWindow(turn);
    const delivered = await sendPayload(turn, applyTextToPayload(payload, text), {
      afterAcceptedDraft,
      durable: true,
      promptContextSequence,
      onPlatformSendDispatch,
      bindPendingFinalDelivery,
    });
    if (!delivered) {
      return { kind: "skipped" };
    }
    turn.answerLane.finalized = true;
    markFinalDelivered(turn);
    return { kind: "sent" };
  }
  const delivered = await sendPayload(turn, applyTextToPayload(payload, text), {
    afterAcceptedDraft,
    durable: true,
    promptContextSequence,
    onPlatformSendDispatch,
    bindPendingFinalDelivery,
  });
  // The final must dispatch before the activity window retires, so the answer
  // lane cannot accept follow-ups against a stale preview message.
  await teardownProgressWindow(turn);
  if (!delivered) {
    return { kind: "skipped" };
  }
  turn.answerLane.finalized = true;
  markFinalDelivered(turn);
  return { kind: "sent" };
}

export async function deliverFinalAnswerText(
  turn: Turn,
  answerPayload: ReplyPayload,
  text: string,
  buttons?: TelegramInlineButtons,
  onPlatformSendDispatch?: () => Promise<void>,
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T,
): Promise<LaneDeliveryResult> {
  const transcriptFinal = await turn.resolveCurrentTurnTranscriptFinal();
  const finalText = await resolveTranscriptBackedChannelFinalText({
    finalText: text,
    resolveCandidateText: async () => transcriptFinal?.text,
  });
  const source = resolvePromptContextSource(
    turn,
    transcriptFinal,
    answerPayload,
    applyTextToPayload(answerPayload, finalText),
  );
  const promptContextSequence = createPromptContextSequence(turn, source);
  const isFollowUp = turn.finalAnswerDelivered;
  let result: LaneDeliveryResult;
  if (!isFollowUp && turn.streamMode === "progress") {
    result = await deliverTelegramProgressModeFinalAnswer(
      turn,
      answerPayload,
      finalText,
      promptContextSequence,
      onPlatformSendDispatch,
      bindPendingFinalDelivery,
    );
  } else {
    if (isFollowUp) {
      await prepareAnswerLaneForText(turn);
    } else if (!(await rotateAnswerLaneAfterToolProgress(turn))) {
      await rotateAnswerLaneAfterQueuedBlocksSettle(turn);
    }
    result = await turn.deliverLaneText({
      laneName: "answer",
      text: finalText,
      payload: answerPayload,
      infoKind: "final",
      buttons,
      allowStream: !usesNativeTelegramQuote(turn, answerPayload),
      promptContextSequence,
      onPlatformSendDispatch,
      bindPendingFinalDelivery,
    });
    if (!isFollowUp && result.kind !== "skipped") {
      markFinalDelivered(turn);
    }
  }
  if (result.kind === "preview-finalized" || result.kind === "preview-finalized-partial") {
    await emitPreviewFinalizedHook(turn, result);
  }
  if (result.kind === "preview-finalized") {
    registerTelegramQuestionDeliveryForMessage(turn, answerPayload, {
      messageId: result.delivery.messageId,
      text: result.delivery.content,
    });
  }
  if (result.kind === "preview-finalized-partial") {
    throw mergeTelegramPartialDeliveryError(result.error, {
      receipt: result.delivery.receipt,
      content: result.delivery.content,
      messageIds: result.delivery.receipt.platformMessageIds,
      visibleReplySent: true,
    });
  }
  return result;
}

export async function finalizePendingAnswerBlockDraft(turn: Turn): Promise<void> {
  const block = turn.activeAnswerBlockDelivery;
  if (
    !block ||
    turn.queuedFinal ||
    turn.dispatchError ||
    turn.isSuperseded() ||
    turn.answerLane.finalized
  ) {
    return;
  }
  const content = block.text.trimEnd();
  if (!content) {
    return;
  }
  markFinalStarted(turn);
  await deliverFinalAnswerText(turn, block.payload, content, block.buttons);
  turn.activeAnswerBlockDelivery = undefined;
}

export async function deliverFallback(turn: Turn, replies: ReplyPayload[], silent: boolean) {
  return await (turn.telegramDeps.deliverReplies ?? deliverReplies)({
    replies,
    ...createDeliveryBaseOptions(turn),
    silent,
    mediaLoader: turn.telegramDeps.loadWebMedia,
  });
}

export function normalizeDeliveryPayload(
  turn: Turn,
  payload: ReplyPayload,
): ReplyPayload | undefined {
  const keepReasoningLane = payload.isReasoning === true && turn.durableReasoningPayloadsEnabled;
  const payloadForPlan = keepReasoningLane ? { ...payload } : payload;
  if (keepReasoningLane) {
    delete payloadForPlan.isReasoning;
  }
  const normalized = projectPayloadForDelivery(turn, payloadForPlan);
  if (!normalized) {
    return undefined;
  }
  // Retained finals can still select HTML at send time, and HTML bypasses
  // rich blocks. Converting a presentation here would strip it while the
  // final funnel is still undecided, so rich accounts defer canonicalization
  // to the sender which knows the text mode.
  if (turn.telegramCfg.richMessages === true && normalized.presentation) {
    return normalized;
  }
  return canonicalizeTelegramPresentationPayload(normalized, {
    allowWebAppButtons: resolveTelegramTargetChatType(String(turn.context.chatId)) === "direct",
    richTables: false,
  });
}

export function createDeliveryState(
  config: TelegramDeliveryConfig,
  getTurn: () => Turn,
): TelegramDeliveryStateSlice {
  const { context } = config;
  const sessionKey = context.ctxPayload.SessionKey;
  const implicitQuoteReplyTargetId =
    context.ctxPayload.ReplyToIsQuote &&
    !context.msg.reply_to_message?.from?.is_bot &&
    config.replyQuoteMessageId != null
      ? String(config.replyQuoteMessageId)
      : undefined;
  const currentMessageIdForQuoteReply =
    implicitQuoteReplyTargetId && context.ctxPayload.MessageSid
      ? context.ctxPayload.MessageSid
      : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const deliverLaneText = createLaneTextDeliverer({
    lanes: config.lanes,
    applyTextToPayload,
    sendPayload: async (payload, options) => await sendPayload(getTurn(), payload, options),
    flushDraftLane: async (lane) => await flushDraftLane(getTurn(), lane),
    stopDraftLane: async (lane) => await lane.stream?.stop(),
    clearDraftLane: async (lane) => await lane.stream?.clear(),
    editStreamMessage: async ({ messageId, text, textMode, buttons }) => {
      const turn = getTurn();
      if (!turn.isSuperseded()) {
        await (turn.telegramDeps.editMessageTelegram ?? editMessageTelegram)(
          turn.context.chatId,
          messageId,
          text,
          {
            api: turn.bot.api,
            cfg: turn.cfg,
            accountId: turn.context.route.accountId,
            linkPreview: turn.telegramCfg.linkPreview,
            textMode,
            buttons,
          },
        );
      }
    },
    createPromptContextSequence: () => createPromptContextSequence(getTurn()),
    resolveFinalTextCandidate: async () =>
      (await getTurn().resolveCurrentTurnTranscriptFinal())?.text,
    log: logVerbose,
    markDelivered: deliveryState.markDelivered,
  });

  return {
    deliveryState,
    deliverLaneText,
    // Draft's rotate path calls this through the turn record: a direct import
    // from draft.ts would recreate the draft<->delivery runtime import cycle.
    materializeAnswerLaneBeforeRotation: async () =>
      await materializeAnswerLaneBeforeRotation(getTurn()),
    resolveCurrentTurnTranscriptFinal: createCurrentTurnTranscriptFinalResolver({
      agentId: context.route.agentId,
      dispatchStartedAt: config.dispatchStartedAt,
      loadFreshSessionEntry: config.loadFreshSessionEntry,
      sessionKey,
    }),
    transcriptMirrorSequence: 0,
    transcriptMirrorTurnId: `${context.chatId}:${context.ctxPayload.MessageSid ?? context.msg.message_id ?? config.dispatchStartedAt}`,
    implicitQuoteReplyTargetId,
    currentMessageIdForQuoteReply,
  };
}
