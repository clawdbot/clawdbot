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

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-chunking";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createQQBotMarkdownChunker } from "../messaging/markdown-table-chunking.js";
import {
  parseAndSendMediaTags,
  sendPlainReply,
  sendTextOnlyReply,
  TEXT_CHUNK_LIMIT,
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
import { resolveResponseTimeoutMs } from "./response-timeout.js";
import type {
  GatewayAccount,
  EngineLogger,
  GatewayPluginRuntime,
  OutboundResult,
} from "./types.js";

// ============ Config ============

// Historical floor for the QQBot outbound response watchdog (5 min). The
// effective wait budget is now derived from existing
// `agents.defaults.timeoutSeconds` and `models.providers.<id>.timeoutSeconds`
// via `resolveResponseTimeoutMs(cfg)` — see issue #85267, where a slow
// local ollama/qwen3.5:27b turn was capped at 5 min despite a configured
// 1800s provider timeout.
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
  isError?: boolean;
};

function shouldDeliverToolProgressImmediately(
  account: GatewayAccount,
  useOfficialC2cStream: boolean,
): boolean {
  if (useOfficialC2cStream) {
    return true;
  }
  // Absent streaming keeps tool progress buffered; a configured object opts in
  // unless mode is "off". Legacy scalar spellings are doctor-migrated.
  const streaming = account.config?.streaming;
  return typeof streaming === "object" && streaming !== null && streaming.mode !== "off";
}

function immediateToolProgressText(payload: ReplyDeliverPayload): string | undefined {
  const text = (payload.text ?? "").trim();
  if (!text || payload.isError || payload.audioAsVoice) {
    return undefined;
  }
  if (payload.mediaUrl || payload.mediaUrls?.length) {
    return undefined;
  }
  return text;
}

function hasReplyMedia(payload: ReplyDeliverPayload): boolean {
  return Boolean(payload.mediaUrl || payload.mediaUrls?.length);
}

function isSilentBlockReplyText(text: string): boolean {
  return !text || text === "[SKIP]" || isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN);
}

function blockReplyTextForDelivery(payload: ReplyDeliverPayload): string {
  const text = payload.text ?? "";
  return isSilentBlockReplyText(text.trim()) ? "" : text;
}

function isSilentBlockReply(payload: ReplyDeliverPayload): boolean {
  return !hasReplyMedia(payload) && isSilentBlockReplyText((payload.text ?? "").trim());
}

function isMediaOnlyBlockReply(payload: ReplyDeliverPayload): boolean {
  return hasReplyMedia(payload) && isSilentBlockReplyText((payload.text ?? "").trim());
}

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

  const openClawCfg = cfg as OpenClawConfig;
  const routeAgentId = inbound.route.agentId ?? resolveDefaultAgentId(openClawCfg);
  const workspaceDir = resolveAgentWorkspaceDir(openClawCfg, routeAgentId);
  const gatewayMediaContext = workspaceDir
    ? { mediaAccess: { workspaceDir }, mediaLocalRoots: [workspaceDir] }
    : {};
  const replyTarget = {
    type: event.type,
    senderId: event.senderId,
    messageId: event.messageId,
    channelId: event.channelId,
    guildId: event.guildId,
    groupOpenid: event.groupOpenid,
  };
  const replyCtx = { target: replyTarget, account, cfg, log, ...gatewayMediaContext };

  const sendWithRetry = <T>(sendFn: (token: string) => Promise<T>) =>
    sendWithTokenRetry(account.appId, account.clientSecret, sendFn, log, account.accountId);

  const sendErrorMessage = (errorText: string) => sendErrorToTarget(replyCtx, errorText);

  // ---- Build ctxPayload ----
  const ctxPayload = await buildCtxPayload(inbound, runtime, cfg);

  // ---- Deliver state ----
  let hasResponse = false;
  let hasBlockResponse = false;
  let hasVisibleBlockResponse = false;
  let toolDeliverCount = 0;
  const toolTexts: string[] = [];
  const toolMediaUrls: string[] = [];
  let toolFallbackSent = false;
  let toolRenewalCount = 0;
  let skippedSilentBlockResponse = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

  const markBlockResponse = (): void => {
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
  };

  // ---- Tool fallback ----
  const sendToolMediaWithTimeout = async (
    mediaUrl: string,
    labels: { resultError: string; thrownError: string },
  ): Promise<void> => {
    const ac = new AbortController();
    let mediaTimeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        sendMedia({
          to: qualifiedTarget,
          text: "",
          mediaUrl,
          accountId: account.accountId,
          replyToId: event.messageId,
          account,
          ...gatewayMediaContext,
        }).then((r) => {
          if (ac.signal.aborted) {
            return { channel: "qqbot", error: "suppressed" } as OutboundResult;
          }
          return r;
        }),
        new Promise<OutboundResult>((resolve) => {
          mediaTimeoutId = setTimeout(() => {
            ac.abort();
            resolve({ channel: "qqbot", error: "timeout" });
          }, TOOL_MEDIA_SEND_TIMEOUT);
        }),
      ]);
      if (result.error) {
        log?.error(`${labels.resultError}: ${result.error}`);
      }
    } catch (err) {
      log?.error(`${labels.thrownError}: ${String(err)}`);
    } finally {
      if (mediaTimeoutId) {
        clearTimeout(mediaTimeoutId);
      }
    }
  };

  const sendToolFallback = async (): Promise<void> => {
    if (toolMediaUrls.length > 0) {
      for (const mediaUrl of toolMediaUrls) {
        await sendToolMediaWithTimeout(mediaUrl, {
          resultError: "Tool fallback error",
          thrownError: "Tool fallback failed",
        });
      }
    }
    if (toolTexts.length > 0) {
      await sendErrorMessage(truncateUtf16Safe(toolTexts.slice(-3).join("\n---\n"), 2000));
    }
  };

  const hasPendingToolFallbackPayload = (): boolean =>
    toolTexts.length > 0 || toolMediaUrls.length > 0;

  const flushPendingToolDeliveriesOnce = async (): Promise<boolean> => {
    if (toolFallbackSent || !hasPendingToolFallbackPayload()) {
      return false;
    }
    await flushPendingToolDeliveries();
    toolFallbackSent = true;
    recordOutbound();
    return true;
  };

  const renewToolOnlyFallback = (): boolean => {
    if (toolFallbackSent) {
      return false;
    }
    if (toolOnlyTimeoutId) {
      if (toolRenewalCount >= MAX_TOOL_RENEWALS) {
        return false;
      }
      clearTimeout(toolOnlyTimeoutId);
      toolRenewalCount++;
    }
    toolOnlyTimeoutId = setTimeout(() => {
      if (!hasBlockResponse && !toolFallbackSent && !skippedSilentBlockResponse) {
        toolFallbackSent = true;
        void sendToolFallback().catch(() => {});
      }
    }, TOOL_ONLY_TIMEOUT);
    return true;
  };

  // ---- Timeout promise ----
  // #85267: derive watchdog from existing agent / provider timeout config so
  // a longer configured ceiling (e.g. slow local ollama models) is not
  // silently undercut by a plugin-local 5-minute cap.
  const responseTimeoutMs = resolveResponseTimeoutMs(cfg);
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!hasResponse) {
        reject(new Error("Response timeout"));
      }
    }, responseTimeoutMs);
  });

  // ---- Deliver deps ----
  const markdownChunker = createQQBotMarkdownChunker((text, limit) =>
    runtime.channel.text.chunkMarkdownText(text, limit),
  );
  const deliverDeps: DeliverDeps = {
    mediaSender: {
      sendPhoto: (target, imageUrl) => sendPhoto(target, imageUrl),
      sendVoice: (target, voicePath, uploadFormats, transcodeEnabled) =>
        sendVoice(target, voicePath, uploadFormats, transcodeEnabled),
      sendVideoMsg: (target, videoPath) => sendVideoMsg(target, videoPath),
      sendDocument: (target, filePath) => sendDocument(target, filePath),
      sendMedia: (opts) => sendMedia(opts),
    },
    chunkText: (text, limit) => markdownChunker.chunkText(text, limit),
  };
  const flushPendingMarkdownText = async (): Promise<void> => {
    const pendingChunks = markdownChunker.flushPendingText(TEXT_CHUNK_LIMIT);
    if (pendingChunks.length === 0) {
      return;
    }
    const passthroughDeps: DeliverDeps = {
      ...deliverDeps,
      chunkText: (text) => [text],
    };
    for (const chunk of pendingChunks) {
      await sendTextOnlyReply(
        chunk,
        {
          type: event.type,
          senderId: event.senderId,
          messageId: event.messageId,
          channelId: event.channelId,
          groupOpenid: event.groupOpenid,
          msgIdx: event.msgIdx,
        },
        { account, qualifiedTarget, log },
        sendWithRetry,
        () => undefined,
        passthroughDeps,
      );
      recordOutbound();
    }
  };

  const replyDeps: ReplyDispatcherDeps = {
    tts: {
      textToSpeech: (params) => runtime.tts.textToSpeech(params),
      audioFileToSilkBase64: async (p) => (await audioFileToSilkBase64(p)) ?? undefined,
    },
  };

  const flushPendingToolDeliveries = async (): Promise<void> => {
    if (toolMediaUrls.length > 0) {
      const urlsToSend = [...toolMediaUrls];
      toolMediaUrls.length = 0;
      for (const mediaUrl of urlsToSend) {
        await sendToolMediaWithTimeout(mediaUrl, {
          resultError: "Tool media forward error",
          thrownError: "Tool media forward failed",
        });
      }
    }

    if (toolTexts.length > 0) {
      const textsToSend = [...toolTexts];
      toolTexts.length = 0;
      for (const text of textsToSend) {
        await sendTextOnlyReply(
          text,
          {
            type: event.type,
            senderId: event.senderId,
            messageId: event.messageId,
            channelId: event.channelId,
            groupOpenid: event.groupOpenid,
            msgIdx: event.msgIdx,
          },
          { account, qualifiedTarget, log, ...gatewayMediaContext },
          sendWithRetry,
          () => undefined,
          deliverDeps,
        );
      }
    }
  };

  const recordOutbound = () =>
    runtime.channel.activity.record({
      channel: "qqbot",
      accountId: account.accountId,
      direction: "outbound",
    });

  // ---- Dispatch ----
  const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, routeAgentId);

  const targetType =
    event.type === "c2c"
      ? ("c2c" as const)
      : event.type === "group"
        ? ("group" as const)
        : ("channel" as const);
  const useOfficialC2cStream = shouldUseOfficialC2cStream(account, targetType);
  const deliverToolProgressImmediately = shouldDeliverToolProgressImmediately(
    account,
    useOfficialC2cStream,
  );
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
        ...gatewayMediaContext,
      },
    });
  }

  const cfgWithSession = cfg as { session?: { store?: unknown } };
  const storePath = runtime.channel.session.resolveStorePath(cfgWithSession.session?.store, {
    agentId: routeAgentId,
  });
  const dispatchPromise = runtime.channel.inbound.run({
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
                  const textOnlyProgress = immediateToolProgressText(payload);
                  if (!hasBlockResponse && deliverToolProgressImmediately && textOnlyProgress) {
                    if (toolOnlyTimeoutId || hasPendingToolFallbackPayload()) {
                      renewToolOnlyFallback();
                    }
                    await sendTextOnlyReply(
                      textOnlyProgress,
                      {
                        type: event.type,
                        senderId: event.senderId,
                        messageId: event.messageId,
                        channelId: event.channelId,
                        groupOpenid: event.groupOpenid,
                        msgIdx: event.msgIdx,
                      },
                      { account, qualifiedTarget, log, ...gatewayMediaContext },
                      sendWithRetry,
                      () => undefined,
                      deliverDeps,
                    );
                    recordOutbound();
                    return;
                  }
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
                          ...gatewayMediaContext,
                        });
                      } catch {}
                    }
                    return;
                  }
                  if (toolFallbackSent) {
                    return;
                  }
                  renewToolOnlyFallback();
                  return;
                }

                // ---- Block deliver ----
                markBlockResponse();

                if (!streamingController && isSilentBlockReply(payload)) {
                  if (!(await flushPendingToolDeliveriesOnce()) && event.type === "group") {
                    log?.info(
                      `Model decided to skip group message (${(payload.text ?? "").trim() || "empty reply"}) from ${event.senderId}`,
                    );
                  }
                  return;
                }
                hasVisibleBlockResponse = true;

                if (
                  streamingController &&
                  !streamingController.isTerminalPhase &&
                  !isMediaOnlyBlockReply(payload)
                ) {
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

                let replyText = blockReplyTextForDelivery(payload);
                const deliverEvent = {
                  type: event.type,
                  senderId: event.senderId,
                  messageId: event.messageId,
                  channelId: event.channelId,
                  groupOpenid: event.groupOpenid,
                  msgIdx: event.msgIdx,
                };
                const deliverActx = { account, qualifiedTarget, log, ...gatewayMediaContext };

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
              onSkip: (
                _payload: ReplyDeliverPayload,
                info: { kind: string; reason: "empty" | "silent" | "heartbeat" },
              ) => {
                if (
                  !streamingController &&
                  (info.kind === "block" || info.kind === "final") &&
                  (info.reason === "silent" || info.reason === "empty")
                ) {
                  skippedSilentBlockResponse = true;
                }
              },
              onFreshSettledDelivery: async () => {
                if (skippedSilentBlockResponse && !hasVisibleBlockResponse) {
                  markBlockResponse();
                  if (await flushPendingToolDeliveriesOnce()) {
                    return { visibleReplySent: true };
                  }
                }
                return undefined;
              },
            },
            replyOptions: {
              disableBlockStreaming: useOfficialC2cStream
                ? true
                : account.config?.streaming?.mode === "off",
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
      timeoutId = null;
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (toolOnlyTimeoutId) {
      clearTimeout(toolOnlyTimeoutId);
      toolOnlyTimeoutId = null;
    }
    if (
      toolDeliverCount > 0 &&
      !hasBlockResponse &&
      !toolFallbackSent &&
      !skippedSilentBlockResponse
    ) {
      toolFallbackSent = true;
      await sendToolFallback();
    }
    await flushPendingMarkdownText();
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

function resolveCommandSource(
  inbound: InboundContext,
  runtime: GatewayPluginRuntime,
  cfg: unknown,
): "text" | undefined {
  const commandBody = inbound.event.content;
  if (!runtime.channel.commands?.isControlCommandMessage?.(commandBody, cfg)) {
    return undefined;
  }
  return "text";
}

async function buildCtxPayload(
  inbound: InboundContext,
  runtime: GatewayPluginRuntime,
  cfg: unknown,
): Promise<FinalizedMsgContext> {
  const { event } = inbound;
  const commandSource = resolveCommandSource(inbound, runtime, cfg);
  const hasImageMedia = inbound.localMediaPaths.length > 0 || inbound.remoteMediaUrls.length > 0;
  return buildChannelInboundEventContext({
    finalize: runtime.channel.reply.finalizeInboundContext,
    channel: "qqbot",
    accountId: inbound.route.accountId,
    messageId: event.messageId,
    timestamp: new Date(event.timestamp).getTime(),
    from: inbound.fromAddress,
    sender: {
      id: event.senderId,
      name: event.senderName,
    },
    conversation: {
      kind: inbound.isGroupChat ? "group" : "direct",
      id: inbound.peerId,
    },
    route: {
      agentId: inbound.route.agentId ?? resolveDefaultAgentId(cfg as OpenClawConfig),
      routeSessionKey: inbound.route.sessionKey,
      accountId: inbound.route.accountId,
    },
    reply: {
      to: inbound.fromAddress,
    },
    message: {
      body: inbound.body,
      bodyForAgent: inbound.agentBody,
      rawBody: event.content,
      commandBody: event.content,
    },
    access: {
      commands: {
        authorized: inbound.commandAuthorized,
      },
    },
    command: commandSource
      ? {
          kind: "text-slash",
          body: event.content,
          authorized: inbound.commandAuthorized,
        }
      : undefined,
    media: hasImageMedia
      ? undefined
      : inbound.voiceMediaTypes.map((contentType) => ({ contentType })),
    supplemental: {
      quote: inbound.replyTo
        ? {
            id: inbound.replyTo.id,
            body: inbound.replyTo.body,
            sender: inbound.replyTo.sender,
            isQuote: inbound.replyTo.isQuote,
          }
        : undefined,
      groupSystemPrompt: inbound.groupSystemPrompt,
    },
    extra: {
      QQChannelId: event.channelId,
      QQGuildId: event.guildId,
      QQGroupOpenid: event.groupOpenid,
      QQVoiceAsrReferAvailable: inbound.hasAsrReferFallback,
      QQVoiceTranscriptSources: inbound.voiceTranscriptSources,
      QQVoiceAttachmentPaths: inbound.uniqueVoicePaths,
      QQVoiceAttachmentUrls: inbound.uniqueVoiceUrls,
      QQVoiceAsrReferTexts: inbound.uniqueVoiceAsrReferTexts,
      QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
      ...(commandSource ? { CommandSource: commandSource } : {}),
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
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
