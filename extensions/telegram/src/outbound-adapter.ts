// Telegram plugin module implements outbound adapter behavior.
import {
  resolveOutboundSendDep,
  sanitizeForPlainText,
  type OutboundDeliveryFormattingOptions,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  resolveSendableOutboundReplyParts,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { mergeTelegramAccountConfig, resolveDefaultTelegramAccountId } from "./accounts.js";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "./button-types.js";
import { TELEGRAM_MAX_CAPTION_LENGTH, telegramCaptionDeliveryMetadata } from "./caption.js";
import { splitTelegramHtmlChunks } from "./format.js";
import {
  canonicalizeTelegramPresentationPayload,
  resolveTelegramInteractiveTextFallback,
  resolveTelegramPresentationCapabilities,
} from "./interactive-fallback.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import {
  createTelegramPromptContextProjectionCursor,
  resolveTelegramPromptContextSource,
} from "./prompt-context-projection.js";
import { registerTelegramQuestionDelivery } from "./question-finalization.js";
import { loadTelegramSendModule, type TelegramSendModule } from "./send-runtime.js";
import { normalizeTelegramOutboundTarget, parseTelegramTarget } from "./targets.js";
import { resolveTelegramTextChunkLimit, TELEGRAM_TEXT_CHUNK_LIMIT } from "./text-chunk-limit.js";

export { TELEGRAM_TEXT_CHUNK_LIMIT } from "./text-chunk-limit.js";

const TELEGRAM_POLL_OPTION_LIMIT = 12;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
type TelegramReactionFn = typeof import("./send.js").reactMessageTelegram;
type TelegramLocationFn = typeof import("./send.js").sendLocationTelegram;
type ResolveTelegramSendFn = (deps?: OutboundSendDeps) => Promise<TelegramSendFn>;
type LoadTelegramSendModuleFn = () => Promise<TelegramSendModule>;

function toTelegramOutboundResult<T extends { chatId?: string }>(result: T) {
  const { chatId, ...delivery } = result;
  return chatId === undefined
    ? delivery
    : { ...delivery, target: { kind: "chat" as const, id: chatId } };
}

async function resolveDefaultTelegramSend(deps?: OutboundSendDeps): Promise<TelegramSendFn> {
  return (
    resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram
  );
}

function chunkTelegramOutboundText(
  text: string,
  limit: number,
  ctx?: { formatting?: OutboundDeliveryFormattingOptions },
): string[] {
  return ctx?.formatting?.parseMode === "HTML"
    ? splitTelegramHtmlChunks(text, limit)
    : chunkMarkdownTextWithMode(text, limit, ctx?.formatting?.chunkMode ?? "length");
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  replyToIdSource?: TelegramSendOpts["replyToIdSource"];
  replyToMode?: TelegramSendOpts["replyToMode"];
  threadId?: string | number | null;
  formatting?: OutboundDeliveryFormattingOptions;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
  onDeliveryResult?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onDeliveryResult"];
  onPlatformSendDispatch?: () => Promise<void>;
  resolveSend: ResolveTelegramSendFn;
}): Promise<{
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode?: "html";
    tableMode?: OutboundDeliveryFormattingOptions["tableMode"];
    messageThreadId?: number;
    replyToMessageId?: number;
    replyToIdSource?: TelegramSendOpts["replyToIdSource"];
    replyToMode?: TelegramSendOpts["replyToMode"];
    accountId?: string;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
    onDeliveryResult?: TelegramSendOpts["onDeliveryResult"];
    onPlatformSendDispatch?: TelegramSendOpts["onPlatformSendDispatch"];
  };
}> {
  const send = await params.resolveSend(params.deps);
  return {
    send,
    baseOpts: {
      verbose: false,
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      ...(params.replyToIdSource !== undefined ? { replyToIdSource: params.replyToIdSource } : {}),
      ...(params.replyToMode !== undefined ? { replyToMode: params.replyToMode } : {}),
      accountId: params.accountId ?? undefined,
      silent: params.silent,
      gatewayClientScopes: params.gatewayClientScopes,
      onDeliveryResult: params.onDeliveryResult
        ? async (result) => {
            await params.onDeliveryResult?.(
              attachChannelToResult("telegram", toTelegramOutboundResult(result)),
            );
          }
        : undefined,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      ...(params.formatting?.parseMode === "HTML" ? { textMode: "html" as const } : {}),
      tableMode: params.formatting?.tableMode,
    },
  };
}

async function resolveTelegramOutboundSendContext(
  params: Parameters<typeof resolveTelegramSendContext>[0] & { to: string },
) {
  const outboundTo = normalizeTelegramOutboundTarget(params.to);
  const { send, baseOpts } = await resolveTelegramSendContext(params);
  return { outboundTo, send, baseOpts };
}

// Native table rendering requires the account's rich markdown funnel; HTML-mode
// text stays on the legacy parse_mode sender where table islands never convert.
function telegramRichTablesEnabled(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  accountId?: string | null;
  htmlTextMode: boolean;
}): boolean {
  if (params.htmlTextMode) {
    return false;
  }
  return (
    mergeTelegramAccountConfig(
      params.cfg,
      params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
    ).richMessages === true
  );
}

type CreateTelegramOutboundAdapterOptions = {
  resolveSend?: ResolveTelegramSendFn;
  loadSendModule?: LoadTelegramSendModuleFn;
  beforeDeliverPayload?: ChannelOutboundAdapter["beforeDeliverPayload"];
  shouldSuppressLocalPayloadPrompt?: ChannelOutboundAdapter["shouldSuppressLocalPayloadPrompt"];
  shouldTreatDeliveredTextAsVisible?: ChannelOutboundAdapter["shouldTreatDeliveredTextAsVisible"];
  targetsMatchForReplySuppression?: ChannelOutboundAdapter["targetsMatchForReplySuppression"];
  preferFinalAssistantVisibleText?: boolean;
};

function normalizeTelegramMetadataOnlyPayload(payload: ReplyPayload): ReplyPayload | null {
  const telegramData = payload.channelData?.telegram as
    | {
        buttons?: TelegramInlineButtons;
        quoteText?: string;
        reaction?: { emoji?: unknown; replyToId?: unknown; replyToCurrent?: unknown };
      }
    | undefined;
  const text = resolveTelegramInteractiveTextFallback({
    text: payload.text,
    interactive: payload.interactive,
    presentation: payload.presentation,
  });
  if (
    text?.trim() ||
    resolveSendableOutboundReplyParts(payload).mediaUrls.length > 0 ||
    payload.location ||
    payload.audioAsVoice === true ||
    payload.videoAsNote === true ||
    payload.presentation ||
    payload.interactive
  ) {
    return payload;
  }
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation: payload.presentation,
    interactive: payload.interactive,
  });
  const hasQuoteText =
    typeof telegramData?.quoteText === "string" && Boolean(telegramData.quoteText.trim());
  const hasReaction =
    typeof telegramData?.reaction?.emoji === "string" &&
    Boolean(telegramData.reaction.emoji.trim());
  if (hasReaction && !buttons?.length && !hasQuoteText) {
    return payload;
  }
  const fallbackText = payload.fallbackText?.text.trim();
  if (!buttons?.length && !hasQuoteText) {
    return null;
  }
  return fallbackText ? { ...payload, text: fallbackText } : null;
}

function mergeTelegramFallbackPayloads(source: ReplyPayload, adopter: ReplyPayload): ReplyPayload {
  const sourceTelegram = source.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const adopterTelegram = adopter.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const buttons = [...(sourceTelegram?.buttons ?? []), ...(adopterTelegram?.buttons ?? [])];
  const quoteText = sourceTelegram?.quoteText?.trim()
    ? sourceTelegram.quoteText
    : adopterTelegram?.quoteText;
  const telegram =
    sourceTelegram || adopterTelegram
      ? {
          ...adopterTelegram,
          ...sourceTelegram,
          ...(buttons.length > 0 ? { buttons } : {}),
          ...(quoteText ? { quoteText } : {}),
        }
      : undefined;
  return {
    ...adopter,
    ...source,
    fallbackText: adopter.fallbackText,
    channelData: {
      ...adopter.channelData,
      ...source.channelData,
      ...(telegram ? { telegram } : {}),
    },
  };
}

function normalizeTelegramFallbackPayloadBatch(
  entries: readonly { index: number; payload: ReplyPayload }[],
): ReadonlyArray<ReplyPayload | null> {
  const normalized: Array<ReplyPayload | null> = entries.map((entry) => entry.payload);
  const positions = new Map(entries.map((entry, position) => [entry.index, position]));
  for (const [position, entry] of entries.entries()) {
    const fallback = entry.payload.fallbackText;
    if (
      fallback?.replacesPayloadIndex === undefined ||
      entry.payload.text?.trim() !== fallback.text.trim() ||
      entry.payload.interactive ||
      entry.payload.presentation ||
      resolveSendableOutboundReplyParts(entry.payload).mediaUrls.length > 0 ||
      entry.payload.location ||
      entry.payload.audioAsVoice === true ||
      entry.payload.videoAsNote === true
    ) {
      continue;
    }
    const channelData = entry.payload.channelData;
    const channelDataKeys = channelData ? Object.keys(channelData) : [];
    const telegramData = channelData?.telegram as
      | {
          buttons?: TelegramInlineButtons;
          quoteText?: string;
          reaction?: unknown;
        }
      | undefined;
    if (
      channelDataKeys.length !== 1 ||
      channelDataKeys[0] !== "telegram" ||
      !telegramData?.buttons?.length ||
      telegramData.quoteText?.trim() ||
      telegramData.reaction
    ) {
      continue;
    }
    const sourcePosition = positions.get(fallback.replacesPayloadIndex);
    if (sourcePosition === undefined) {
      continue;
    }
    const source = normalized[sourcePosition];
    if (!source || source.text?.trim() !== fallback.text.trim()) {
      continue;
    }
    normalized[sourcePosition] = mergeTelegramFallbackPayloads(source, entry.payload);
    normalized[position] = null;
  }
  return normalized;
}

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  sendLocation: TelegramLocationFn;
  react: TelegramReactionFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const payload = canonicalizeTelegramPresentationPayload(params.payload, {
    allowWebAppButtons: parseTelegramTarget(params.to).chatType === "direct",
    richTables: telegramRichTablesEnabled({
      cfg: params.baseOpts.cfg,
      accountId: params.baseOpts.accountId,
      htmlTextMode: params.baseOpts.textMode === "html",
    }),
  });
  const telegramData = payload.channelData?.telegram as
    | {
        buttons?: TelegramInlineButtons;
        quoteText?: string;
        reaction?: { emoji?: unknown; replyToId?: unknown; replyToCurrent?: unknown };
      }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const reactionEmoji =
    typeof telegramData?.reaction?.emoji === "string" ? telegramData.reaction.emoji : undefined;
  const text =
    resolveTelegramInteractiveTextFallback({
      text: payload.text,
      interactive: payload.interactive,
      presentation: payload.presentation,
    }) ?? "";
  const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation: payload.presentation,
    interactive: payload.interactive,
  });
  const replyToMessageId = parseStrictPositiveInteger(
    telegramData?.reaction?.replyToId ?? params.baseOpts.replyToMessageId,
  );
  const promptContextSource = resolveTelegramPromptContextSource(params.payload);
  const projectionCursor = promptContextSource
    ? createTelegramPromptContextProjectionCursor(promptContextSource)
    : undefined;
  const projectionOptions = (finalPart: boolean) =>
    projectionCursor
      ? { promptContextProjectionPlan: { cursor: projectionCursor, finalPart } }
      : {};
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
    ...(payload.audioAsVoice === true ? { asVoice: true } : {}),
    ...(payload.videoAsNote === true ? { asVideoNote: true } : {}),
  };
  if (payload.location) {
    if (
      mediaUrls.length > 0 ||
      reactionEmoji ||
      payload.audioAsVoice === true ||
      payload.videoAsNote === true
    ) {
      throw new Error("Telegram location sends cannot be combined with media or reactions.");
    }
    if (text.trim()) {
      // Cross-context policy can add a required origin marker to an otherwise
      // standalone location. Persist it as a separate send without stealing
      // the location's native reply, quote, or buttons.
      await params.send(params.to, text, {
        ...params.baseOpts,
        replyToMessageId: undefined,
        replyToIdSource: undefined,
        replyToMode: undefined,
      });
    }
    return await params.sendLocation(params.to, payload.location, {
      ...params.baseOpts,
      ...projectionOptions(true),
      buttons,
      quoteText,
    });
  }
  if (payload.videoAsNote === true && mediaUrls.length !== 1) {
    throw new Error("Telegram video notes require exactly one media attachment.");
  }
  const shouldConsumeImplicitReplyTarget =
    payloadOpts.replyToIdSource === "implicit" &&
    payloadOpts.replyToMode !== undefined &&
    isSingleUseReplyToMode(payloadOpts.replyToMode);
  const consumedImplicitReplyPayloadOpts = shouldConsumeImplicitReplyTarget
    ? {
        ...payloadOpts,
        replyToMessageId: undefined,
        replyToIdSource: undefined,
        replyToMode: undefined,
      }
    : payloadOpts;
  let implicitReplyTargetAvailable = true;
  if (reactionEmoji) {
    if (typeof replyToMessageId !== "number") {
      throw new Error("Telegram reaction requires a reply target");
    }
    await params.baseOpts.onPlatformSendDispatch?.();
    const reactionResult = await params.react(params.to, replyToMessageId, reactionEmoji, {
      cfg: params.baseOpts.cfg,
      accountId: params.baseOpts.accountId,
      gatewayClientScopes: params.baseOpts.gatewayClientScopes,
      verbose: false,
    });
    if (!reactionResult.ok) {
      throw new Error(reactionResult.warning);
    }
  }
  if (reactionEmoji && !text && mediaUrls.length === 0 && !buttons?.length) {
    return { messageId: String(replyToMessageId), chatId: params.to };
  }

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await params.send(params.to, text, {
        ...payloadOpts,
        ...projectionOptions(true),
        buttons,
      }),
    send: async ({ text: textLocal, mediaUrl, index, isFirst }) => {
      const mediaPayloadOpts =
        shouldConsumeImplicitReplyTarget && !implicitReplyTargetAvailable
          ? consumedImplicitReplyPayloadOpts
          : payloadOpts;
      implicitReplyTargetAvailable = false;
      return await params.send(params.to, textLocal, {
        ...mediaPayloadOpts,
        ...projectionOptions(index === mediaUrls.length - 1),
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      });
    },
  });
}

export function createTelegramOutboundAdapter(
  options: CreateTelegramOutboundAdapterOptions = {},
): ChannelOutboundAdapter {
  const resolveSend = options.resolveSend ?? resolveDefaultTelegramSend;
  const loadSendModule = options.loadSendModule ?? loadTelegramSendModule;

  return {
    deliveryMode: "direct",
    chunker: chunkTelegramOutboundText,
    chunkerMode: "markdown",
    extractMarkdownImages: true,
    textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
    preserveMarkdownDetails: ({ cfg, accountId }) =>
      mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg))
        .richMessages === true,
    // Default Telegram delivery reparses this result as Markdown; use its bold
    // and strike delimiters. Rich accounts must keep the agent's HTML islands
    // (<details>, <tg-math-block>, checkbox lists) intact — the blocks emitter
    // owns them and keeps unsupported tags visibly literal, so tag-stripping
    // here would silently flatten the advertised rich contract.
    sanitizeText: ({ text, cfg, accountId }) =>
      cfg &&
      mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg))
        .richMessages === true
        ? sanitizeAssistantVisibleText(text)
        : sanitizeForPlainText(sanitizeAssistantVisibleText(text), { style: "markdown" }),
    shouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,
    beforeDeliverPayload: options.beforeDeliverPayload,
    shouldTreatDeliveredTextAsVisible: options.shouldTreatDeliveredTextAsVisible,
    targetsMatchForReplySuppression: options.targetsMatchForReplySuppression,
    preferFinalAssistantVisibleText: options.preferFinalAssistantVisibleText,
    normalizePayload: ({ payload }) => normalizeTelegramMetadataOnlyPayload(payload),
    normalizePayloadBatch: ({ payloads }) => normalizeTelegramFallbackPayloadBatch(payloads),
    presentationCapabilities: resolveTelegramPresentationCapabilities({ richMessages: false }),
    resolvePresentationCapabilities: ({ cfg, accountId, formatting }) =>
      resolveTelegramPresentationCapabilities({
        richMessages: telegramRichTablesEnabled({
          cfg,
          accountId,
          htmlTextMode: formatting?.parseMode === "HTML",
        }),
      }),
    deliveryCapabilities: {
      pin: true,
      durableFinal: {
        text: true,
        media: true,
        payload: true,
        silent: true,
        replyTo: true,
        thread: true,
        nativeQuote: false,
        messageSendingHooks: true,
        batch: true,
      },
    },
    renderPresentation: ({ payload, presentation, ctx }) =>
      canonicalizeTelegramPresentationPayload(
        { ...payload, presentation },
        {
          allowWebAppButtons: parseTelegramTarget(ctx.to ?? "").chatType === "direct",
          richTables: telegramRichTablesEnabled({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            htmlTextMode: ctx.formatting?.parseMode === "HTML",
          }),
        },
      ),
    afterDeliverPayload: ({ cfg, target, payload, results }) => {
      const telegramResults = results.filter(
        (candidate) => candidate.channel === "telegram" && candidate.messageId,
      );
      const result =
        telegramResults.find((candidate) => candidate.meta?.telegramHasInlineKeyboard === true) ??
        telegramResults.at(-1);
      const text = (
        typeof result?.meta?.telegramDeliveredText === "string"
          ? result.meta.telegramDeliveredText
          : payload.text
      )?.trim();
      if (!result || !text) {
        return;
      }
      const chatId =
        result.target?.kind === "chat"
          ? result.target.id
          : normalizeTelegramOutboundTarget(target.to);
      const messageId = result.messageId;
      const accountId = target.accountId ?? undefined;
      const deliveredPart = result.receipt?.parts.find(
        (part) => part.platformMessageId === messageId,
      );
      const isCaptionDelivery =
        deliveredPart?.kind === "media" ||
        (deliveredPart?.kind !== "text" &&
          result.meta !== undefined &&
          telegramCaptionDeliveryMetadata.has(result.meta));
      registerTelegramQuestionDelivery({
        accountId,
        chatId,
        messageId,
        payload,
        text,
        textLimit: isCaptionDelivery ? TELEGRAM_MAX_CAPTION_LENGTH : TELEGRAM_TEXT_CHUNK_LIMIT,
        clearButtons: async () => {
          const { editMessageReplyMarkupTelegram } = await loadSendModule();
          await editMessageReplyMarkupTelegram(chatId, messageId, [], {
            cfg,
            accountId,
            verbose: false,
          });
        },
        annotate: async (finalText) => {
          const { editMessageTelegram } = await loadSendModule();
          await editMessageTelegram(chatId, messageId, finalText, {
            cfg,
            accountId,
            verbose: false,
            ...(isCaptionDelivery ? { editMode: "caption" } : {}),
          });
        },
      });
    },
    pinDeliveredMessage: async ({ cfg, target, messageId, pin, gatewayClientScopes }) => {
      const { pinMessageTelegram } = await loadSendModule();
      const outboundTo = normalizeTelegramOutboundTarget(target.to);
      const pinTarget = parseTelegramTarget(outboundTo);
      await pinMessageTelegram(pinTarget.chatId, messageId, {
        cfg,
        accountId: target.accountId ?? undefined,
        notify: pin.notify,
        verbose: false,
        gatewayClientScopes,
      });
    },
    resolveEffectiveTextChunkLimit: ({ cfg, accountId, formatting }) =>
      resolveTelegramTextChunkLimit({ cfg, accountId, formatting }),
    pollMaxOptions: TELEGRAM_POLL_OPTION_LIMIT,
    supportsPollDurationSeconds: true,
    supportsAnonymousPolls: true,
    ...createAttachedChannelResultAdapter({
      channel: "telegram",
      sendText: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return toTelegramOutboundResult(
          await send(outboundTo, params.text, {
            ...baseOpts,
          }),
        );
      },
      sendMedia: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return toTelegramOutboundResult(
          await send(outboundTo, params.text, {
            ...baseOpts,
            mediaUrl: params.mediaUrl,
            ...(params.mediaAccess !== undefined ? { mediaAccess: params.mediaAccess } : {}),
            mediaLocalRoots: params.mediaLocalRoots,
            mediaReadFile: params.mediaReadFile,
            forceDocument: params.forceDocument ?? false,
          }),
        );
      },
    }),
    sendPayload: async (params) => {
      const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
        ...params,
        resolveSend,
      });
      const { reactMessageTelegram, sendLocationTelegram } = await loadSendModule();
      const result = await sendTelegramPayloadMessages({
        send,
        sendLocation: sendLocationTelegram,
        react: reactMessageTelegram,
        to: outboundTo,
        payload: params.payload,
        baseOpts: {
          ...baseOpts,
          ...(params.mediaAccess !== undefined ? { mediaAccess: params.mediaAccess } : {}),
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          forceDocument: params.forceDocument ?? false,
        },
      });
      return attachChannelToResult("telegram", toTelegramOutboundResult(result));
    },
    sendPoll: async ({
      cfg,
      to,
      poll,
      accountId,
      threadId,
      silent,
      isAnonymous,
      gatewayClientScopes,
      onPlatformSendDispatch,
    }) => {
      const outboundTo = normalizeTelegramOutboundTarget(to);
      const { sendPollTelegram } = await loadSendModule();
      return await sendPollTelegram(outboundTo, poll, {
        cfg,
        accountId: accountId ?? undefined,
        messageThreadId: parseTelegramThreadId(threadId),
        silent: silent ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
        gatewayClientScopes,
        onPlatformSendDispatch,
      });
    },
  };
}

export const telegramOutbound: ChannelOutboundAdapter = createTelegramOutboundAdapter();
