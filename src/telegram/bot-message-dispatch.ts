// @ts-nocheck
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { danger, logVerbose } from "../globals.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
import { resolveAgentDir } from "../agents/agent-scope.js";

async function resolveStickerVisionSupport(cfg, agentId) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) return false;
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
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
  opts,
  resolveBotTopicsEnabled,
}) => {
  const {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    resolvedThreadId,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const isPrivateChat = msg.chat.type === "private";
  const draftMaxChars = Math.min(textLimit, 4096);
  const canStreamDraft =
    streamMode !== "off" &&
    isPrivateChat &&
    typeof resolvedThreadId === "number" &&
    (await resolveBotTopicsEnabled(primaryCtx));
  const draftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        draftId: msg.message_id || Date.now(),
        maxChars: draftMaxChars,
        messageThreadId: resolvedThreadId,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) return;
    if (text === lastPartialText) return;
    if (streamMode === "partial") {
      lastPartialText = text;
      draftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = text;
    if (!delta) return;
    if (!draftChunker) {
      draftText = text;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };
  const flushDraft = async () => {
    if (!draftStream) return;
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) draftStream.update(draftText);
    }
    await draftStream.flush();
  };

  const disableBlockStreaming =
    Boolean(draftStream) ||
    (typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : undefined);

  const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Clear media paths so native vision doesn't process the image again
        ctxPayload.MediaPath = undefined;
        ctxPayload.MediaType = undefined;
        ctxPayload.MediaUrl = undefined;
        ctxPayload.MediaPaths = undefined;
        ctxPayload.MediaUrls = undefined;
        ctxPayload.MediaTypes = undefined;
      }

      // Cache the description for future encounters
      cacheSticker({
        fileId: sticker.fileId,
        fileUniqueId: sticker.fileUniqueId,
        emoji: sticker.emoji,
        setName: sticker.setName,
        description,
        cachedAt: new Date().toISOString(),
        receivedFrom: ctxPayload.From,
      });
      logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
    }
  }

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      deliver: async (payload, info) => {
        if (info.kind === "final") {
          await flushDraft();
          draftStream?.stop();
        }

        const replyQuoteText =
          ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
            ? ctxPayload.ReplyToBody.trim() || undefined
            : undefined;
        await deliverReplies({
          replies: [payload],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          messageThreadId: resolvedThreadId,
          tableMode,
          chunkMode,
          onVoiceRecording: sendRecordVoice,
          linkPreview: telegramCfg.linkPreview,
          replyQuoteText,
        });
      },
      onError: (err, info) => {
        runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: createTypingCallbacks({
        start: sendTyping,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      }).onReplyStart,
    },
    replyOptions: {
      skillFilter,
      onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
      onReasoningStream: draftStream
        ? (payload) => {
            if (payload.text) draftStream.update(payload.text);
          }
        : undefined,
      disableBlockStreaming,
      onModelSelected: (ctx) => {
        prefixContext.onModelSelected(ctx);
      },
    },
  });
  draftStream?.stop();
  if (!queuedFinal) {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) return;
      logAckFailure({
        log: logVerbose,
        channel: "telegram",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
  }
};
