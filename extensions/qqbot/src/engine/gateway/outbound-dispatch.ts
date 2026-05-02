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

import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
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
import { StreamingController, shouldUseOfficialC2cStream } from "../messaging/streaming-c2c.js";
import { audioFileToSilkBase64 } from "../utils/audio.js";
import type { InboundContext } from "./inbound-context.js";
import type {
  GatewayAccount,
  EngineLogger,
  GatewayPluginRuntime,
  OutboundResult,
} from "./types.js";

// ============ Config ============

const RESPONSE_TIMEOUT = 300_000;
const TOOL_ONLY_TIMEOUT = 60_000;
const MAX_TOOL_RENEWALS = 3;
const TOOL_MEDIA_SEND_TIMEOUT = 45_000;

// ============ Dependencies ============

interface OutboundDispatchDeps {
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

  const targetType =
    event.type === "c2c"
      ? ("c2c" as const)
      : event.type === "group"
        ? ("group" as const)
        : ("channel" as const);
  const useOfficialC2cStream = shouldUseOfficialC2cStream(account, targetType);
  let streamingController: StreamingController | null = null;
  if (useOfficialC2cStream) {
    streamingController = new StreamingController({
      account,
      userId: event.senderId,
      replyToMsgId: event.messageId,
      eventId: event.messageId,
      logPrefix: `[qqbot:${account.accountId}:streaming]`,
      log,
      mediaContext: {
        account,
        event: {
          type: event.type as "c2c" | "group" | "channel",
          senderId: event.senderId,
          messageId: event.messageId,
          groupOpenid: event.groupOpenid,
          channelId: event.channelId,
        },
        log,
      },
    });
  }

  const cfgWithSession = cfg as { session?: { store?: unknown } };
  const agentId = inbound.route.agentId ?? "default";
  const storePath = runtime.channel.session.resolveStorePath(cfgWithSession.session?.store, {
    agentId,
  });
  const dispatchPromise = runtime.channel.turn.run({
    channel: "qqbot",
    accountId: inbound.route.accountId,
    raw: inbound,
    adapter: {
      ingest: () => ({
        id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
        rawText: ctxPayload.RawBody ?? "",
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: inbound,
      }),
      resolveTurn: () => ({
        channel: "qqbot",
        accountId: inbound.route.accountId,
        routeSessionKey: inbound.route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: runtime.channel.session.recordInboundSession,
        record: {
          onRecordError: (err: unknown) => {
            log?.error(
              `Session metadata update failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        },
        runDispatch: () =>
          runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
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

                if (streamingController && !streamingController.isTerminalPhase) {
                  try {
                    await streamingController.onDeliver(payload);
                  } catch (err) {
                    log?.error(
                      `Streaming deliver error: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  }

                  const replyPreview = (payload.text ?? "").trim();
                  if (
                    event.type === "group" &&
                    (replyPreview === "NO_REPLY" || replyPreview === "[SKIP]")
                  ) {
                    log?.info(
                      `Model decided to skip group message (${replyPreview}) from ${event.senderId}`,
                    );
                    return;
                  }

                  if (streamingController.shouldFallbackToStatic) {
                    log?.info("Streaming API unavailable, falling back to static for this deliver");
                  } else {
                    recordOutbound();
                    return;
                  }
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
                if (
                  payload.audioAsVoice === true &&
                  !payload.mediaUrl &&
                  !payload.mediaUrls?.length
                ) {
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
                if (streamingController && !streamingController.isTerminalPhase) {
                  try {
                    await streamingController.onError(err);
                  } catch (streamErr) {
                    const streamErrMsg =
                      streamErr instanceof Error ? streamErr.message : String(streamErr);
                    log?.error(`Streaming onError failed: ${streamErrMsg}`);
                  }
                  if (!streamingController.shouldFallbackToStatic) {
                    return;
                  }
                }
                const errMsg = err instanceof Error ? err.message : String(err);
                log?.error(`Dispatch error: ${errMsg}`);
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
              },
            },
            replyOptions: {
              disableBlockStreaming: useOfficialC2cStream
                ? true
                : (() => {
                    const s = account.config?.streaming;
                    if (s === false) {
                      return true;
                    }
                    return typeof s === "object" && s !== null && s.mode === "off";
                  })(),
              ...(streamingController
                ? {
                    onPartialReply: async (payload: { text?: string }) => {
                      try {
                        await streamingController.onPartialReply(payload);
                      } catch (partialErr) {
                        log?.error(
                          `Streaming onPartialReply error: ${partialErr instanceof Error ? partialErr.message : String(partialErr)}`,
                        );
                      }
                    },
                  }
                : {}),
            },
          }),
      }),
    },
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
    if (streamingController && !streamingController.isTerminalPhase) {
      try {
        streamingController.markFullyComplete();
        await streamingController.onIdle();
      } catch (finalizeErr) {
        log?.error(
          `Streaming finalization error: ${finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr)}`,
        );
        try {
          await streamingController.abortStreaming();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ============ ctxPayload builder ============

function buildCtxPayload(
  inbound: InboundContext,
  runtime: GatewayPluginRuntime,
): FinalizedMsgContext {
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
  }) as FinalizedMsgContext;
}
