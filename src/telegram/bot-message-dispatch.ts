// @ts-nocheck
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../agents/identity.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import { clearHistoryEntries } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { danger, logVerbose } from "../globals.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";

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

  // Create mutable context for response prefix template interpolation
  let prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(cfg, route.agentId),
  };

  let didSendReply = false;
  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
      responsePrefixContextProvider: () => prefixContext,
      deliver: async (payload, info) => {
        if (info.kind === "final") {
          await flushDraft();
          draftStream?.stop();
        }
        await deliverReplies({
          replies: [payload],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          messageThreadId: resolvedThreadId,
        });
        didSendReply = true;
      },
      onError: (err, info) => {
        runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: sendTyping,
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
        // Mutate the object directly instead of reassigning to ensure the closure sees updates
        prefixContext.provider = ctx.provider;
        prefixContext.model = extractShortModelName(ctx.model);
        prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
        prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
      },
    },
  });
  draftStream?.stop();
  if (!queuedFinal) {
    if (isGroup && historyKey && historyLimit > 0 && didSendReply) {
      clearHistoryEntries({ historyMap: groupHistories, historyKey });
    }
    return;
  }
  if (removeAckAfterReply && ackReactionPromise && msg.message_id && reactionApi) {
    void ackReactionPromise.then((didAck) => {
      if (!didAck) return;
      reactionApi(chatId, msg.message_id, []).catch((err) => {
        logVerbose(
          `telegram: failed to remove ack reaction from ${chatId}/${msg.message_id}: ${String(err)}`,
        );
      });
    });
  }
  if (isGroup && historyKey && historyLimit > 0 && didSendReply) {
    clearHistoryEntries({ historyMap: groupHistories, historyKey });
  }
};
