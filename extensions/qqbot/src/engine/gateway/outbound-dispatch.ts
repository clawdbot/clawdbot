/**
 * Outbound dispatcher — manage AI reply delivery, tool fallback, and timeouts.
 *
 * Responsibilities:
 * 1. Build ctxPayload and call runtime.dispatchReply
 * 2. Tool deliver collection + fallback timeout
 * 3. Block deliver pipeline (consumeQuoteRef → media tags → structured payload → plain text)
 * 4. Timeout / error handling
 *
 * Separated from gateway.ts for testability and to keep handleMessage thin.
 */

import {
  parseAndSendMediaTags,
  sendPlainReply,
  type DeliverDeps,
} from "../messaging/outbound-deliver.js";
import {
  sendDocument,
  sendMedia,
  sendPhoto,
  sendVoice,
  sendVideoMsg,
} from "../messaging/outbound.js";
import {
  handleStructuredPayload,
  sendTextAsVoiceReply,
  sendErrorToTarget,
  sendWithTokenRetry,
  type ReplyDispatcherDeps,
} from "../messaging/reply-dispatcher.js";
import { audioFileToSilkBase64 } from "../utils/audio.js";
import type { InboundContext } from "./inbound-context.js";
import type {
  GatewayAccount,
  EngineLogger,
  GatewayPluginRuntime,
  OutboundResult,
} from "./types.js";

// ============ Config ============

const RESPONSE_TIMEOUT = 120_000;
const TOOL_ONLY_TIMEOUT = 60_000;
const MAX_TOOL_RENEWALS = 3;
const TOOL_MEDIA_SEND_TIMEOUT = 45_000;

// ============ Dependencies ============

export interface OutboundDispatchDeps {
  runtime: GatewayPluginRuntime;
  cfg: unknown;
  account: GatewayAccount;
  log?: EngineLogger;
}

type ReplyDeliverPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
};

// ============ dispatchOutbound ============

/**
 * Dispatch the AI reply for the given inbound context.
 *
 * Handles tool deliver collection, block deliver pipeline, and timeouts.
 * The caller is responsible for stopping typing.keepAlive in `finally`.
 */
export async function dispatchOutbound(
  inbound: InboundContext,
  deps: OutboundDispatchDeps,
): Promise<void> {
  const { runtime, cfg, account, log } = deps;
  const { event, qualifiedTarget } = inbound;

  const replyTarget = {
    type: event.type,
    senderId: event.senderId,
    messageId: event.messageId,
    channelId: event.channelId,
    guildId: event.guildId,
    groupOpenid: event.groupOpenid,
  };
  const replyCtx = { target: replyTarget, account, cfg, log };

  const sendWithRetry = <T>(sendFn: (token: string) => Promise<T>) =>
    sendWithTokenRetry(account.appId, account.clientSecret, sendFn, log, account.accountId);

  const sendErrorMessage = (errorText: string) => sendErrorToTarget(replyCtx, errorText);

  // ---- Build ctxPayload ----
  const ctxPayload = buildCtxPayload(inbound, runtime);

  // ---- Deliver state ----
  let hasResponse = false;
  let hasBlockResponse = false;
  let toolDeliverCount = 0;
  const toolTexts: string[] = [];
  const toolMediaUrls: string[] = [];
  let toolFallbackSent = false;
  let toolRenewalCount = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // ---- Tool fallback ----
  const sendToolFallback = async (): Promise<void> => {
    if (toolMediaUrls.length > 0) {
      for (const mediaUrl of toolMediaUrls) {
        const ac = new AbortController();
        try {
          const result = await Promise.race([
            sendMedia({
              to: qualifiedTarget,
              text: "",
              mediaUrl,
              accountId: account.accountId,
              replyToId: event.messageId,
              account,
            }).then((r) => {
              if (ac.signal.aborted) {
                return { channel: "qqbot", error: "suppressed" } as OutboundResult;
              }
              return r;
            }),
            new Promise<OutboundResult>((resolve) =>
              setTimeout(() => {
                ac.abort();
                resolve({ channel: "qqbot", error: "timeout" });
              }, TOOL_MEDIA_SEND_TIMEOUT),
            ),
          ]);
          if (result.error) {
            log?.error(`Tool fallback error: ${result.error}`);
          }
        } catch (err) {
          log?.error(`Tool fallback failed: ${String(err)}`);
        }
      }
      return;
    }
    if (toolTexts.length > 0) {
      await sendErrorMessage(toolTexts.slice(-3).join("\n---\n").slice(0, 2000));
    }
  };

  // ---- Timeout promise ----
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!hasResponse) {
        reject(new Error("Response timeout"));
      }
    }, RESPONSE_TIMEOUT);
  });

  // ---- Deliver deps ----
  const deliverDeps: DeliverDeps = {
    mediaSender: {
      sendPhoto: (target, imageUrl) => sendPhoto(target, imageUrl),
      sendVoice: (target, voicePath, uploadFormats, transcodeEnabled) =>
        sendVoice(target, voicePath, uploadFormats, transcodeEnabled),
      sendVideoMsg: (target, videoPath) => sendVideoMsg(target, videoPath),
      sendDocument: (target, filePath) => sendDocument(target, filePath),
      sendMedia: (opts) => sendMedia(opts),
    },
    chunkText: (text, limit) => runtime.channel.text.chunkMarkdownText(text, limit),
  };

  const replyDeps: ReplyDispatcherDeps = {
    tts: {
      textToSpeech: (params) => runtime.tts.textToSpeech(params),
      audioFileToSilkBase64: async (p) => (await audioFileToSilkBase64(p)) ?? undefined,
    },
  };

  const recordOutbound = () =>
    runtime.channel.activity.record({
      channel: "qqbot",
      accountId: account.accountId,
      direction: "outbound",
    });

  // ---- Dispatch ----
  const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(
    cfg,
    inbound.route.agentId,
  );

  const dispatchPromise = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      responsePrefix: messagesConfig.responsePrefix,
      deliver: async (payload: ReplyDeliverPayload, info: { kind: string }) => {
        hasResponse = true;

        // ---- Tool deliver ----
        if (info.kind === "tool") {
          toolDeliverCount++;
          const toolText = (payload.text ?? "").trim();
          if (toolText) {
            toolTexts.push(toolText);
          }
          if (payload.mediaUrls?.length) {
            toolMediaUrls.push(...payload.mediaUrls);
          }
          if (payload.mediaUrl && !toolMediaUrls.includes(payload.mediaUrl)) {
            toolMediaUrls.push(payload.mediaUrl);
          }

          if (hasBlockResponse && toolMediaUrls.length > 0) {
            const urlsToSend = [...toolMediaUrls];
            toolMediaUrls.length = 0;
            for (const mediaUrl of urlsToSend) {
              try {
                await sendMedia({
                  to: qualifiedTarget,
                  text: "",
                  mediaUrl,
                  accountId: account.accountId,
                  replyToId: event.messageId,
                  account,
                });
              } catch {}
            }
            return;
          }
          if (toolFallbackSent) {
            return;
          }
          if (toolOnlyTimeoutId) {
            if (toolRenewalCount < MAX_TOOL_RENEWALS) {
              clearTimeout(toolOnlyTimeoutId);
              toolRenewalCount++;
            } else {
              return;
            }
          }
          toolOnlyTimeoutId = setTimeout(async () => {
            if (!hasBlockResponse && !toolFallbackSent) {
              toolFallbackSent = true;
              try {
                await sendToolFallback();
              } catch {}
            }
          }, TOOL_ONLY_TIMEOUT);
          return;
        }

        // ---- Block deliver ----
        hasBlockResponse = true;
        inbound.typing.keepAlive?.stop();
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (toolOnlyTimeoutId) {
          clearTimeout(toolOnlyTimeoutId);
          toolOnlyTimeoutId = null;
        }

        const quoteRef = event.msgIdx;
        let quoteRefUsed = false;
        const consumeQuoteRef = (): string | undefined => {
          if (quoteRef && !quoteRefUsed) {
            quoteRefUsed = true;
            return quoteRef;
          }
          return undefined;
        };

        let replyText = payload.text ?? "";
        const deliverEvent = {
          type: event.type,
          senderId: event.senderId,
          messageId: event.messageId,
          channelId: event.channelId,
          groupOpenid: event.groupOpenid,
          msgIdx: event.msgIdx,
        };
        const deliverActx = { account, qualifiedTarget, log };

        // 1. Media tags
        const mediaResult = await parseAndSendMediaTags(
          replyText,
          deliverEvent,
          deliverActx,
          sendWithRetry,
          consumeQuoteRef,
          deliverDeps,
        );
        if (mediaResult.handled) {
          recordOutbound();
          return;
        }
        replyText = mediaResult.normalizedText;

        // 2. Structured payload (QQBOT_PAYLOAD:)
        const handled = await handleStructuredPayload(
          replyCtx,
          replyText,
          recordOutbound,
          replyDeps,
        );
        if (handled) {
          return;
        }

        // 3. Voice-intent plain text
        if (payload.audioAsVoice === true && !payload.mediaUrl && !payload.mediaUrls?.length) {
          const sentVoice = await sendTextAsVoiceReply(replyCtx, replyText, replyDeps);
          if (sentVoice) {
            recordOutbound();
            return;
          }
        }

        // 4. Plain text + images/media
        await sendPlainReply(
          payload,
          replyText,
          deliverEvent,
          deliverActx,
          sendWithRetry,
          consumeQuoteRef,
          toolMediaUrls,
          deliverDeps,
        );
        recordOutbound();
      },
      onError: async (err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log?.error(`Dispatch error: ${errMsg}`);
        hasResponse = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      },
    },
    replyOptions: { disableBlockStreaming: account.config.streaming?.mode === "off" },
  });

  try {
    await Promise.race([dispatchPromise, timeoutPromise]);
  } catch {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  } finally {
    if (toolOnlyTimeoutId) {
      clearTimeout(toolOnlyTimeoutId);
      toolOnlyTimeoutId = null;
    }
    if (toolDeliverCount > 0 && !hasBlockResponse && !toolFallbackSent) {
      toolFallbackSent = true;
      await sendToolFallback();
    }
  }
}

// ============ ctxPayload builder ============

function buildCtxPayload(inbound: InboundContext, runtime: GatewayPluginRuntime): unknown {
  const { event } = inbound;
  return runtime.channel.reply.finalizeInboundContext({
    Body: inbound.body,
    BodyForAgent: inbound.agentBody,
    RawBody: event.content,
    CommandBody: event.content,
    From: inbound.fromAddress,
    To: inbound.fromAddress,
    SessionKey: inbound.route.sessionKey,
    AccountId: inbound.route.accountId,
    ChatType: inbound.isGroupChat ? "group" : "direct",
    GroupSystemPrompt: inbound.groupSystemPrompt,
    SenderId: event.senderId,
    SenderName: event.senderName,
    Provider: "qqbot",
    Surface: "qqbot",
    MessageSid: event.messageId,
    Timestamp: new Date(event.timestamp).getTime(),
    OriginatingChannel: "qqbot",
    OriginatingTo: inbound.fromAddress,
    QQChannelId: event.channelId,
    QQGuildId: event.guildId,
    QQGroupOpenid: event.groupOpenid,
    QQVoiceAsrReferAvailable: inbound.hasAsrReferFallback,
    QQVoiceTranscriptSources: inbound.voiceTranscriptSources,
    QQVoiceAttachmentPaths: inbound.uniqueVoicePaths,
    QQVoiceAttachmentUrls: inbound.uniqueVoiceUrls,
    QQVoiceAsrReferTexts: inbound.uniqueVoiceAsrReferTexts,
    QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
    CommandAuthorized: inbound.commandAuthorized,
    ...(inbound.voiceMediaTypes.length > 0
      ? {
          MediaTypes: inbound.voiceMediaTypes,
          MediaType: inbound.voiceMediaTypes[0],
        }
      : {}),
    ...(inbound.localMediaPaths.length > 0
      ? {
          MediaPaths: inbound.localMediaPaths,
          MediaPath: inbound.localMediaPaths[0],
          MediaTypes: inbound.localMediaTypes,
          MediaType: inbound.localMediaTypes[0],
        }
      : {}),
    ...(inbound.remoteMediaUrls.length > 0
      ? { MediaUrls: inbound.remoteMediaUrls, MediaUrl: inbound.remoteMediaUrls[0] }
      : {}),
    ...(inbound.replyTo
      ? {
          ReplyToId: inbound.replyTo.id,
          ReplyToBody: inbound.replyTo.body,
          ReplyToSender: inbound.replyTo.sender,
          ReplyToIsQuote: inbound.replyTo.isQuote,
        }
      : {}),
  });
}
