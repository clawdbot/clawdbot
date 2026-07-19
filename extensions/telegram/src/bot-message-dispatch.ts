// Telegram plugin module coordinates one inbound message dispatch lifecycle.
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/channel-outbound";
import { createSubsystemLogger, danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import { createTelegramDeliveryController } from "./bot-message-dispatch-delivery.js";
import { createTelegramDraftController } from "./bot-message-dispatch-draft.js";
import { createTelegramProgressController } from "./bot-message-dispatch-progress.js";
import { createTelegramReplyDelivery } from "./bot-message-dispatch-reply.js";
import {
  createFreshTelegramSessionEntryLoader,
  resolveTelegramReasoningLevel,
} from "./bot-message-dispatch-session.js";
import { createTelegramDispatchStatus } from "./bot-message-dispatch-status.js";
import { runTelegramDispatchTurn } from "./bot-message-dispatch-turn.js";
import {
  findModelInCatalog,
  loadPreparedModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "./bot-message-dispatch.agent.runtime.js";
import {
  generateTopicLabel,
  getAgentScopedMediaLocalRoots,
  resolveAutoTopicLabelConfig,
  resolveChunkMode,
  resolveMarkdownTableMode,
} from "./bot-message-dispatch.runtime.js";
import type {
  DispatchTelegramMessageParams,
  TelegramDispatchResult,
  TelegramDispatchTurnState,
} from "./bot-message-dispatch.types.js";
import { getTelegramTextParts, resolveTelegramReplyId } from "./bot/helpers.js";
import {
  addTelegramNativeQuoteCandidate,
  buildTelegramNativeQuoteCandidate,
  type TelegramNativeQuoteCandidateByMessageId,
} from "./bot/native-quote.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const silentReplyDispatchLogger = createSubsystemLogger("telegram/silent-reply-dispatch");

async function resolveStickerVisionSupport(
  cfg: DispatchTelegramMessageParams["cfg"],
  agentId: string,
) {
  try {
    const catalog = await loadPreparedModelCatalog({
      config: cfg,
      agentId,
      agentDir: resolveAgentDir(cfg, agentId),
      readOnly: true,
    });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    return entry ? modelSupportsVision(entry) : false;
  } catch {
    return false;
  }
}

function includeStickerDescription(body: string | undefined, formattedDescription: string): string {
  if (!body) {
    return formattedDescription;
  }
  const current = body.trim();
  if (!current || current === "<media:image>") {
    return formattedDescription;
  }
  // Cached descriptions can already be present from inbound context construction.
  // Keep that body intact so captions, forwarded text, and supplemental context survive.
  if (body.includes(formattedDescription)) {
    return body;
  }
  return `${formattedDescription}\n${body}`;
}

function resolveTelegramQuoteContext(params: {
  context: ReturnType<typeof resolveDispatchTelegramContext>;
  replyToMode: DispatchTelegramMessageParams["replyToMode"];
}) {
  const { context, replyToMode } = params;
  const rawReplyQuoteText =
    context.ctxPayload.ReplyToIsQuote && typeof context.ctxPayload.ReplyToQuoteText === "string"
      ? context.ctxPayload.ReplyToQuoteText
      : undefined;
  const replyQuoteText = context.ctxPayload.ReplyToIsQuote
    ? rawReplyQuoteText?.trim()
      ? rawReplyQuoteText
      : context.ctxPayload.ReplyToBody?.trim() || undefined
    : undefined;
  const replyQuoteMessageId =
    replyQuoteText && !context.ctxPayload.ReplyToIsExternal
      ? resolveTelegramReplyId(context.ctxPayload.ReplyToId)
      : undefined;
  const replyQuoteTargetsBotMessage = context.msg.reply_to_message?.from?.is_bot === true;
  const replyQuoteByMessageId: TelegramNativeQuoteCandidateByMessageId = {};
  if (replyToMode !== "off") {
    if (replyQuoteText && replyQuoteMessageId != null) {
      addTelegramNativeQuoteCandidate(replyQuoteByMessageId, replyQuoteMessageId, {
        text: replyQuoteText,
        ...(typeof context.ctxPayload.ReplyToQuotePosition === "number"
          ? { position: context.ctxPayload.ReplyToQuotePosition }
          : {}),
        ...(Array.isArray(context.ctxPayload.ReplyToQuoteEntities)
          ? { entities: context.ctxPayload.ReplyToQuoteEntities }
          : {}),
      });
    }
    addTelegramNativeQuoteCandidate(
      replyQuoteByMessageId,
      context.ctxPayload.MessageSid ?? context.msg.message_id,
      buildTelegramNativeQuoteCandidate(getTelegramTextParts(context.msg)),
    );
    if (
      !context.ctxPayload.ReplyToIsExternal &&
      typeof context.ctxPayload.ReplyToQuoteSourceText === "string"
    ) {
      addTelegramNativeQuoteCandidate(
        replyQuoteByMessageId,
        context.ctxPayload.ReplyToId,
        buildTelegramNativeQuoteCandidate({
          text: context.ctxPayload.ReplyToQuoteSourceText,
          entities: Array.isArray(context.ctxPayload.ReplyToQuoteSourceEntities)
            ? context.ctxPayload.ReplyToQuoteSourceEntities
            : undefined,
        }),
      );
    }
  }
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof context.msg.message_id === "number"
      ? replyQuoteTargetsBotMessage
        ? context.msg.message_id
        : (replyQuoteMessageId ?? context.msg.message_id)
      : undefined;
  return {
    draftReplyToMessageId,
    hasTelegramQuoteReply: replyToMode !== "off" && replyQuoteText != null,
    replyQuoteByMessageId,
    replyQuoteEntities: Array.isArray(context.ctxPayload.ReplyToQuoteEntities)
      ? context.ctxPayload.ReplyToQuoteEntities
      : undefined,
    replyQuoteMessageId,
    replyQuotePosition:
      typeof context.ctxPayload.ReplyToQuotePosition === "number"
        ? context.ctxPayload.ReplyToQuotePosition
        : undefined,
    replyQuoteText,
  };
}

async function prepareTelegramSticker(params: {
  cfg: DispatchTelegramMessageParams["cfg"];
  context: ReturnType<typeof resolveDispatchTelegramContext>;
}) {
  const { context } = params;
  const sticker = context.ctxPayload.Sticker;
  if (!sticker?.fileId || !sticker.fileUniqueId || !context.ctxPayload.MediaPath) {
    return;
  }
  const agentDir = resolveAgentDir(params.cfg, context.route.agentId);
  const stickerSupportsVision = await resolveStickerVisionSupport(
    params.cfg,
    context.route.agentId,
  );
  const description =
    sticker.cachedDescription ||
    (await describeStickerImage({
      imagePath: context.ctxPayload.MediaPath,
      cfg: params.cfg,
      agentDir,
      agentId: context.route.agentId,
    }));
  if (!description) {
    return;
  }
  const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
    .filter(Boolean)
    .join(" ");
  const formattedDescription = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;
  sticker.cachedDescription = description;
  if (!stickerSupportsVision) {
    context.ctxPayload.Body = includeStickerDescription(
      context.ctxPayload.Body,
      formattedDescription,
    );
    context.ctxPayload.BodyForAgent = includeStickerDescription(
      context.ctxPayload.BodyForAgent,
      formattedDescription,
    );
    context.ctxPayload.SkipStickerMediaUnderstanding = true;
  }
  cacheSticker({
    fileId: sticker.fileId,
    fileUniqueId: sticker.fileUniqueId,
    emoji: sticker.emoji,
    setName: sticker.setName,
    description,
    cachedAt: new Date().toISOString(),
    receivedFrom: context.ctxPayload.From,
  });
  logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
}

function scheduleDmTopicLabel(params: {
  bot: DispatchTelegramMessageParams["bot"];
  cfg: DispatchTelegramMessageParams["cfg"];
  context: ReturnType<typeof resolveDispatchTelegramContext>;
  isFirstTurnInSession: boolean;
  telegramCfg: DispatchTelegramMessageParams["telegramCfg"];
}) {
  const { context } = params;
  const isDmTopic =
    !context.isGroup && context.threadSpec.scope === "dm" && context.threadSpec.id != null;
  if (!isDmTopic || !params.isFirstTurnInSession) {
    return;
  }
  const userMessage = truncateUtf16Safe(
    context.ctxPayload.RawBody ?? context.ctxPayload.Body ?? "",
    500,
  );
  if (!userMessage.trim()) {
    return;
  }
  const directAutoTopicLabel =
    context.groupConfig && "autoTopicLabel" in context.groupConfig
      ? context.groupConfig.autoTopicLabel
      : undefined;
  const autoTopicConfig = resolveAutoTopicLabelConfig(
    directAutoTopicLabel,
    params.telegramCfg.autoTopicLabel,
  );
  if (!autoTopicConfig) {
    return;
  }
  const topicThreadId = context.threadSpec.id!;
  void (async () => {
    try {
      const label = await generateTopicLabel({
        userMessage,
        prompt: autoTopicConfig.prompt,
        cfg: params.cfg,
        agentId: context.route.agentId,
        agentDir: resolveAgentDir(params.cfg, context.route.agentId),
      });
      if (!label) {
        logVerbose("auto-topic-label: LLM returned empty label");
        return;
      }
      logVerbose(`auto-topic-label: generated label (len=${label.length})`);
      await params.bot.api.editForumTopic(context.chatId, topicThreadId, { name: label });
      logVerbose(`auto-topic-label: renamed topic ${context.chatId}/${topicThreadId}`);
    } catch (err) {
      logVerbose(`auto-topic-label: failed: ${String(err)}`);
    }
  })();
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  telegramDeps: injectedTelegramDeps,
  opts,
  retryDispatchErrors = false,
  suppressFailureFallback = false,
  turnAdoptionLifecycle,
}: DispatchTelegramMessageParams): Promise<TelegramDispatchResult> => {
  const dispatchStartedAt = Date.now();
  const dispatchContext = resolveDispatchTelegramContext({ context });
  const telegramDeps =
    injectedTelegramDeps ?? (await import("./bot-deps.js")).defaultTelegramBotDeps;
  const loadFreshSessionEntry = createFreshTelegramSessionEntryLoader({ cfg, telegramDeps });
  const isRoomEvent = dispatchContext.ctxPayload.InboundEventKind === "room_event";
  const status = createTelegramDispatchStatus({ cfg, context: dispatchContext });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: dispatchContext.route.accountId,
    supportsBlockTables: telegramCfg.richMessages === true,
  });
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: dispatchContext.ctxPayload.SessionKey,
    agentId: dispatchContext.route.agentId,
    loadFreshSessionEntry,
  });
  const forceBlockStreamingForReasoning =
    resolvedReasoningLevel === "on" && streamMode !== "progress";
  const quote = resolveTelegramQuoteContext({ context: dispatchContext, replyToMode });
  // Pre-adoption abort is drain-owned via turnAdoptionLifecycle.abortSignal.
  const isDispatchSuperseded = () => turnAdoptionLifecycle?.abortSignal?.aborted === true;
  const dispatchGeneration = 0;
  const draft = createTelegramDraftController({
    accountId: dispatchContext.route.accountId,
    bot,
    cfg,
    chatId: dispatchContext.chatId,
    draftReplyToMessageId: quote.draftReplyToMessageId,
    forceBlockStreamingForReasoning,
    hasTelegramQuoteReply: quote.hasTelegramQuoteReply,
    isDispatchSuperseded,
    isRoomEvent,
    replyToMode,
    resolvedReasoningLevel,
    streamMode,
    tableMode,
    telegramCfg,
    telegramDeps,
    textLimit,
    threadSpec: dispatchContext.threadSpec,
  });
  const progress = createTelegramProgressController({
    accountId: dispatchContext.route.accountId,
    chatId: dispatchContext.chatId,
    draft,
    statusReactionController: status.controller,
    streamMode,
    streamReasoningInProgressDraft: draft.streamReasoningInProgressDraft,
    telegramCfg,
    threadId: dispatchContext.threadSpec.id,
  });
  const delivery = createTelegramDeliveryController({
    bot,
    cfg,
    chunkMode: resolveChunkMode(cfg, "telegram", dispatchContext.route.accountId),
    context: dispatchContext,
    dispatchStartedAt,
    draft,
    draftReplyToMessageId: quote.draftReplyToMessageId,
    isDispatchSuperseded,
    loadFreshSessionEntry,
    mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, dispatchContext.route.agentId),
    opts,
    progress,
    replyQuoteByMessageId: quote.replyQuoteByMessageId,
    replyQuoteEntities: quote.replyQuoteEntities,
    replyQuoteMessageId: quote.replyQuoteMessageId,
    replyQuotePosition: quote.replyQuotePosition,
    replyQuoteText: quote.replyQuoteText,
    replyToMode,
    runtime,
    streamMode,
    tableMode,
    telegramCfg,
    telegramDeps,
    textLimit,
    threadSpec: dispatchContext.threadSpec,
  });
  const state: TelegramDispatchTurnState = {
    queuedFinal: false,
    suppressSilentReplyFallback: false,
    hadErrorReplyFailureOrSkip: false,
  };
  const reply = createTelegramReplyDelivery({
    cfg,
    context: dispatchContext,
    delivery,
    draft,
    fence: {
      generation: () => dispatchGeneration,
      isSuperseded: isDispatchSuperseded,
    },
    progress,
    runtime,
    state,
    streamMode,
    telegramCfg,
  });

  let isFirstTurnInSession = false;
  let dispatchWasSuperseded: boolean;
  let turnDispatched: boolean | undefined;
  const isDmTopic =
    !dispatchContext.isGroup &&
    dispatchContext.threadSpec.scope === "dm" &&
    dispatchContext.threadSpec.id != null;
  try {
    await prepareTelegramSticker({ cfg, context: dispatchContext });
    if (isDmTopic) {
      try {
        const sessionKey = dispatchContext.ctxPayload.SessionKey;
        if (sessionKey) {
          isFirstTurnInSession = !loadFreshSessionEntry(dispatchContext.route.agentId, sessionKey)
            .entry?.systemSent;
        } else {
          logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
        }
      } catch (err) {
        logVerbose(`auto-topic-label: session store error: ${String(err)}`);
      }
    }
    loadFreshSessionEntry.clear();
    if (status.controller && !isRoomEvent) {
      void status.controller.setThinking();
    }
    try {
      turnDispatched = await runTelegramDispatchTurn({
        cfg,
        context: dispatchContext,
        delivery,
        draft,
        turnAdoptionLifecycle,
        isSuperseded: isDispatchSuperseded,
        progress,
        reply,
        state,
        statusReactionController: status.controller,
        streamMode,
        telegramCfg,
        telegramDeps,
      });
    } catch (err) {
      state.dispatchError = err;
      runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
    } finally {
      progress.cancel();
      await draft.waitForEvents();
      try {
        await delivery.finalizePendingAnswerBlockDraft(state);
      } catch (err) {
        state.dispatchError ??= err;
        runtime.error?.(danger(`telegram terminal block delivery failed: ${String(err)}`));
      }
      await draft.cleanup(isDispatchSuperseded());
      if (
        streamMode === "progress" &&
        progress.sawProgressFinal() &&
        !state.dispatchError &&
        !state.hadErrorReplyFailureOrSkip &&
        !isDispatchSuperseded()
      ) {
        await delivery.deliverProgressCollapseSummary();
      }
    }
  } finally {
    dispatchWasSuperseded = isDispatchSuperseded();
  }

  if (turnDispatched === false) {
    return { kind: "completed" };
  }
  if (dispatchWasSuperseded) {
    if (status.controller) {
      status.finalizeInBackground({ outcome: "done", hasFinalResponse: true }, "finalize");
    } else {
      status.removeAck();
    }
    return { kind: "completed" };
  }

  const deliverySummary = delivery.snapshot();
  let sentFallback = false;
  const shouldSendFailureFallback =
    !isRoomEvent &&
    !suppressFailureFallback &&
    !progress.finalAnswerDelivered() &&
    (state.dispatchError ||
      deliverySummary.skippedNonSilent > 0 ||
      deliverySummary.failedNonSilent > 0);
  if (shouldSendFailureFallback) {
    const fallbackText = state.dispatchError
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    const result = await delivery.deliverFallback(
      [{ text: fallbackText }],
      telegramCfg.silentErrorReplies === true &&
        (state.dispatchError != null || state.hadErrorReplyFailureOrSkip),
    );
    sentFallback = result.delivered;
  }

  if (
    !sentFallback &&
    !state.dispatchError &&
    !deliverySummary.delivered &&
    !state.suppressSilentReplyFallback &&
    !state.queuedFinal &&
    dispatchContext.isGroup
  ) {
    const policySessionKey =
      dispatchContext.ctxPayload.CommandSource === "native"
        ? (dispatchContext.ctxPayload.CommandTargetSessionKey ??
          dispatchContext.ctxPayload.SessionKey)
        : dispatchContext.ctxPayload.SessionKey;
    const silentReplyFallback = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
        cfg,
        sessionKey: policySessionKey,
        surface: "telegram",
      }),
    );
    if (silentReplyFallback.length > 0) {
      sentFallback = (await delivery.deliverFallback(silentReplyFallback, false)).delivered;
    }
    silentReplyDispatchLogger.debug("telegram turn ended without visible final response", {
      hasSessionKey: Boolean(policySessionKey),
      hasChatId: dispatchContext.chatId != null,
      queuedFinal: state.queuedFinal,
      sentFallback,
    });
  }

  const hasFinalResponse =
    progress.finalAnswerDelivered() ||
    sentFallback ||
    state.suppressSilentReplyFallback ||
    state.queuedFinal;
  const hasVisibleResponse =
    deliverySummary.delivered ||
    sentFallback ||
    state.suppressSilentReplyFallback ||
    state.queuedFinal;
  const deliveryFailureWithoutFinalResponse =
    !progress.finalAnswerDelivered() &&
    (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0);
  const retryableDispatchFailure =
    state.dispatchError ??
    (deliveryFailureWithoutFinalResponse
      ? new Error(
          `Telegram reply delivery failed without a final response (failed=${deliverySummary.failedNonSilent}, skipped=${deliverySummary.skippedNonSilent})`,
        )
      : null);

  if (status.controller && !hasVisibleResponse) {
    status.finalizeInBackground({ outcome: "error", hasFinalResponse: false }, "error finalize");
  }
  const shouldReturnRetryableDispatchFailure =
    retryDispatchErrors &&
    ((state.dispatchError != null && !hasFinalResponse) ||
      (state.dispatchError == null && deliveryFailureWithoutFinalResponse && !hasVisibleResponse));
  if (retryableDispatchFailure && shouldReturnRetryableDispatchFailure) {
    return { kind: "failed-retryable", error: retryableDispatchFailure };
  }
  if (!hasVisibleResponse) {
    return { kind: "completed" };
  }

  scheduleDmTopicLabel({
    bot,
    cfg,
    context: dispatchContext,
    isFirstTurnInSession,
    telegramCfg,
  });
  if (status.controller) {
    status.finalizeInBackground(
      {
        outcome:
          !progress.finalAnswerDelivered() && (state.dispatchError != null || sentFallback)
            ? "error"
            : "done",
        hasFinalResponse: true,
      },
      "finalize",
    );
  } else {
    status.removeAck();
  }
  return { kind: "completed" };
};
