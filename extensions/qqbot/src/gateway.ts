import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import WebSocket from "ws";
import {
  clearTokenCache,
  getAccessToken,
  getGatewayUrl,
  initApiConfig,
  onMessageSent,
  PLUGIN_USER_AGENT,
  sendC2CInputNotify,
  sendC2CMessage,
  sendChannelMessage,
  sendDmMessage,
  sendGroupMessage,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
} from "./api.js";
import { formatQQBotAllowFrom } from "./channel-config-shared.js";
import { formatVoiceText, processAttachments } from "./inbound-attachments.js";
import { flushKnownUsers, recordKnownUser } from "./known-users.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import {
  parseAndSendMediaTags,
  sendPlainReply,
  type DeliverAccountContext,
  type DeliverEventContext,
} from "./outbound-deliver.js";
import { sendDocument, sendMedia as sendMediaAuto, type MediaTargetContext } from "./outbound.js";
import {
  flushRefIndex,
  formatRefEntryForAgent,
  getRefIndex,
  setRefIndex,
  type RefAttachmentSummary,
} from "./ref-index-store.js";
import {
  handleStructuredPayload,
  sendErrorToTarget,
  sendWithTokenRetry,
  type MessageTarget,
  type ReplyContext,
} from "./reply-dispatcher.js";
import { getQQBotRuntime } from "./runtime.js";
import { clearSession, loadSession, saveSession } from "./session-store.js";
import { matchSlashCommand, type SlashCommandContext } from "./slash-commands.js";
import type {
  C2CMessageEvent,
  GroupMessageEvent,
  GuildMessageEvent,
  ResolvedQQBotAccount,
  WSPayload,
} from "./types.js";
import { TYPING_INPUT_SECOND, TypingKeepAlive } from "./typing-keepalive.js";
import { isGlobalTTSAvailable, resolveTTSConfig } from "./utils/audio-convert.js";
import { runDiagnostics } from "./utils/platform.js";
import { buildAttachmentSummaries, parseFaceTags, parseRefIndices } from "./utils/text-parsing.js";

// QQ Bot intents grouped by permission level.
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

// Always request the full intent set for groups, DMs, and guild channels.
const FULL_INTENTS = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;
const FULL_INTENTS_DESC = "groups + DMs + channels";

// Reconnect configuration.
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const RATE_LIMIT_DELAY = 60000;
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3;
const QUICK_DISCONNECT_THRESHOLD = 5000;

function decodeGatewayMessageData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data) && data.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return "";
}

function readOptionalMessageSceneExt(
  event: GuildMessageEvent | C2CMessageEvent | GroupMessageEvent,
): string[] | undefined {
  if (!("message_scene" in event)) {
    return undefined;
  }
  return event.message_scene?.ext;
}

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * Start the Gateway WebSocket connection with automatic reconnect support.
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // Run environment diagnostics during startup.
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // Initialize API behavior such as markdown support.
  initApiConfig(account.appId, {
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport}`);

  // Cache outbound refIdx values from QQ delivery responses for future quoting.
  onMessageSent(account.appId, (refIdx, meta) => {
    log?.info(
      `[qqbot:${account.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`,
    );
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      // Preserve the original TTS text for voice messages so later quoting can use it.
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
        log?.info(
          `[qqbot:${account.accountId}] Saving voice transcript (TTS): ${meta.ttsText.slice(0, 50)}`,
        );
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: meta.text ?? "",
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    log?.info(
      `[qqbot:${account.accountId}] Cached outbound refIdx: ${refIdx}, attachments=${JSON.stringify(attachments)}`,
    );
  });

  // Log TTS configuration state for diagnostics.
  const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
  if (ttsCfg) {
    const maskedKey =
      ttsCfg.apiKey.length > 8
        ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}`
        : "****";
    log?.info(
      `[qqbot:${account.accountId}] TTS configured (plugin): model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, baseUrl=${ttsCfg.baseUrl}`,
    );
    log?.info(
      `[qqbot:${account.accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ""}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ""}`,
    );
  } else if (isGlobalTTSAvailable(cfg)) {
    const globalProvider = cfg.messages?.tts?.provider ?? "auto";
    log?.info(
      `[qqbot:${account.accountId}] TTS configured (global fallback): provider=${globalProvider}`,
    );
  } else {
    log?.info(
      `[qqbot:${account.accountId}] TTS not configured (voice messages will be unavailable)`,
    );
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime = 0;
  let quickDisconnectCount = 0;
  let isConnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldRefreshToken = false;

  // Restore a persisted session when it still matches the current appId.
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    log?.info(
      `[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}`,
    );
  }

  // Queue messages per peer while still allowing cross-peer concurrency.
  const msgQueue = createMessageQueue({
    accountId: account.accountId,
    log,
    isAborted: () => isAborted,
  });

  // Intercept plugin-level slash commands before queueing normal traffic.
  const URGENT_COMMANDS = ["/stop"];

  const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
    const content = (msg.content ?? "").trim();
    if (!content.startsWith("/")) {
      msgQueue.enqueue(msg);
      return;
    }

    const contentLower = normalizeLowercaseStringOrEmpty(content);
    const isUrgentCommand = URGENT_COMMANDS.some(
      (cmd) =>
        contentLower === normalizeLowercaseStringOrEmpty(cmd) ||
        contentLower.startsWith(normalizeLowercaseStringOrEmpty(cmd) + " "),
    );
    if (isUrgentCommand) {
      log?.info(
        `[qqbot:${account.accountId}] Urgent command detected: ${content.slice(0, 20)}, executing immediately`,
      );
      const peerId = msgQueue.getMessagePeerId(msg);
      const droppedCount = msgQueue.clearUserQueue(peerId);
      if (droppedCount > 0) {
        log?.info(
          `[qqbot:${account.accountId}] Dropped ${droppedCount} queued messages for ${peerId} due to urgent command`,
        );
      }
      msgQueue.executeImmediate(msg);
      return;
    }

    const receivedAt = Date.now();
    const peerId = msgQueue.getMessagePeerId(msg);

    // commandAuthorized is not meaningful for pre-dispatch commands: requireAuth:true
    // commands are in frameworkCommands (not in the local registry) and are never
    // matched by matchSlashCommand, so the auth gate inside it never fires here.
    const cmdCtx: SlashCommandContext = {
      type: msg.type,
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageId: msg.messageId,
      eventTimestamp: msg.timestamp,
      receivedAt,
      rawContent: content,
      args: "",
      channelId: msg.channelId,
      groupOpenid: msg.groupOpenid,
      accountId: account.accountId,
      appId: account.appId,
      accountConfig: account.config,
      commandAuthorized: true,
      queueSnapshot: msgQueue.getSnapshot(peerId),
    };

    try {
      const reply = await matchSlashCommand(cmdCtx);
      if (reply === null) {
        // Not a plugin-level command. Let the normal framework path handle it.
        msgQueue.enqueue(msg);
        return;
      }

      log?.info(
        `[qqbot:${account.accountId}] Slash command matched: ${content}, replying directly`,
      );
      const token = await getAccessToken(account.appId, account.clientSecret);

      // Handle either a plain-text reply or a reply with an attached file.
      // Note: all current pre-dispatch commands return plain strings; the file
      // path below is retained for forward-compatibility if a future requireAuth:false
      // command returns a SlashCommandFileResult.
      const isFileResult = typeof reply === "object" && reply !== null && "filePath" in reply;
      const replyText = isFileResult ? reply.text : reply;
      const replyFile = isFileResult ? reply.filePath : null;

      // Send the text portion first.
      if (msg.type === "c2c") {
        await sendC2CMessage(account.appId, token, msg.senderId, replyText, msg.messageId);
      } else if (msg.type === "group" && msg.groupOpenid) {
        await sendGroupMessage(account.appId, token, msg.groupOpenid, replyText, msg.messageId);
      } else if (msg.channelId) {
        await sendChannelMessage(token, msg.channelId, replyText, msg.messageId);
      } else if (msg.type === "dm" && msg.guildId) {
        await sendDmMessage(token, msg.guildId, replyText, msg.messageId);
      }

      // Send the file attachment if the command produced one.
      if (replyFile) {
        try {
          const targetType =
            msg.type === "group"
              ? "group"
              : msg.type === "dm"
                ? "dm"
                : msg.type === "c2c"
                  ? "c2c"
                  : "channel";
          const targetId =
            msg.type === "group"
              ? msg.groupOpenid || msg.senderId
              : msg.type === "dm"
                ? msg.guildId || msg.senderId
                : msg.type === "c2c"
                  ? msg.senderId
                  : msg.channelId || msg.senderId;
          const mediaCtx: MediaTargetContext = {
            targetType,
            targetId,
            account,
            replyToId: msg.messageId,
            logPrefix: `[qqbot:${account.accountId}]`,
          };
          await sendDocument(mediaCtx, replyFile);
          log?.info(`[qqbot:${account.accountId}] Slash command file sent: ${replyFile}`);
        } catch (fileErr) {
          log?.error(
            `[qqbot:${account.accountId}] Failed to send slash command file: ${String(fileErr)}`,
          );
        }
      }
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Slash command error: ${String(err)}`);
      // Fall back to the normal queue path if the slash command handler fails.
      msgQueue.enqueue(msg);
    }
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    stopBackgroundTokenRefresh(account.appId);
    flushKnownUsers();
    flushRefIndex();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (
      currentWs &&
      (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)
    ) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // Replace any pending reconnect timer with the new one.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(
      `[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`,
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        void connect();
      }
    }, delay);
  };

  const connect = async () => {
    // Do not allow overlapping connection attempts.
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // Clear the cached token before reconnecting when forced refresh was requested.
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }

      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl, { headers: { "User-Agent": PLUGIN_USER_AGENT } });
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // Handle one inbound gateway message after it has left the queue.
      const handleMessage = async (event: {
        type: "c2c" | "guild" | "dm" | "group";
        senderId: string;
        senderName?: string;
        content: string;
        messageId: string;
        timestamp: string;
        channelId?: string;
        guildId?: string;
        groupOpenid?: string;
        attachments?: Array<{
          content_type: string;
          url: string;
          filename?: string;
          voice_wav_url?: string;
          asr_refer_text?: string;
        }>;
        refMsgIdx?: string;
        msgIdx?: string;
      }) => {
        log?.debug?.(`[qqbot:${account.accountId}] Received message: ${JSON.stringify(event)}`);
        log?.info(
          `[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`,
        );
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        // Send typing state and keep it alive for C2C conversations only.
        const isC2C = event.type === "c2c" || event.type === "dm";
        // Keep the mutable handle in an object so TypeScript does not over-narrow it.
        const typing: { keepAlive: TypingKeepAlive | null } = { keepAlive: null };

        const inputNotifyPromise: Promise<string | undefined> = (async () => {
          if (!isC2C) {
            return undefined;
          }
          try {
            let token = await getAccessToken(account.appId, account.clientSecret);
            try {
              const notifyResponse = await sendC2CInputNotify(
                token,
                event.senderId,
                event.messageId,
                TYPING_INPUT_SECOND,
              );
              log?.info(
                `[qqbot:${account.accountId}] Sent input notify to ${event.senderId}${notifyResponse.refIdx ? `, got refIdx=${notifyResponse.refIdx}` : ""}`,
              );
              typing.keepAlive = new TypingKeepAlive(
                () => getAccessToken(account.appId, account.clientSecret),
                () => clearTokenCache(account.appId),
                event.senderId,
                event.messageId,
                log,
                `[qqbot:${account.accountId}]`,
              );
              typing.keepAlive.start();
              return notifyResponse.refIdx;
            } catch (notifyErr) {
              const errMsg = String(notifyErr);
              if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
                log?.info(`[qqbot:${account.accountId}] InputNotify token expired, refreshing...`);
                clearTokenCache(account.appId);
                token = await getAccessToken(account.appId, account.clientSecret);
                const notifyResponse = await sendC2CInputNotify(
                  token,
                  event.senderId,
                  event.messageId,
                  TYPING_INPUT_SECOND,
                );
                typing.keepAlive = new TypingKeepAlive(
                  () => getAccessToken(account.appId, account.clientSecret),
                  () => clearTokenCache(account.appId),
                  event.senderId,
                  event.messageId,
                  log,
                  `[qqbot:${account.accountId}]`,
                );
                typing.keepAlive.start();
                return notifyResponse.refIdx;
              } else {
                throw notifyErr;
              }
            }
          } catch (err) {
            log?.error(
              `[qqbot:${account.accountId}] sendC2CInputNotify error: ${
                err instanceof Error ? err.message : JSON.stringify(err)
              }`,
            );
            return undefined;
          }
        })();

        const isGroupChat = event.type === "guild" || event.type === "group";
        // Keep `peer.id` as the raw peer identifier and let `peer.kind` carry the routing type.
        const peerId =
          event.type === "guild"
            ? (event.channelId ?? "unknown")
            : event.type === "group"
              ? (event.groupOpenid ?? "unknown")
              : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: isGroupChat ? "group" : "direct",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // Static prompting lives in the QQ Bot skills. This body only carries dynamic context.
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }

        const processed = await processAttachments(event.attachments, {
          accountId: account.accountId,
          cfg,
          log,
        });
        const {
          attachmentInfo,
          imageUrls,
          imageMediaTypes,
          voiceAttachmentPaths,
          voiceAttachmentUrls,
          voiceAsrReferTexts,
          voiceTranscripts,
          voiceTranscriptSources,
          attachmentLocalPaths,
        } = processed;

        const voiceText = formatVoiceText(voiceTranscripts);
        const hasAsrReferFallback = voiceTranscriptSources.includes("asr");

        const parsedContent = parseFaceTags(event.content);
        const userContent = voiceText
          ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
          : parsedContent + attachmentInfo;

        let replyToId: string | undefined;
        let replyToBody: string | undefined;
        let replyToSender: string | undefined;
        let replyToIsQuote = false;

        if (event.refMsgIdx) {
          const refEntry = getRefIndex(event.refMsgIdx);
          if (refEntry) {
            replyToId = event.refMsgIdx;
            replyToBody = formatRefEntryForAgent(refEntry);
            replyToSender = refEntry.senderName ?? refEntry.senderId;
            replyToIsQuote = true;
            log?.info(
              `[qqbot:${account.accountId}] Quote detected: refMsgIdx=${event.refMsgIdx}, sender=${replyToSender}, content="${replyToBody.slice(0, 80)}..."`,
            );
          } else {
            log?.info(
              `[qqbot:${account.accountId}] Quote detected but refMsgIdx not in cache: ${event.refMsgIdx}`,
            );
            replyToId = event.refMsgIdx;
            replyToIsQuote = true;
          }
        }

        // Prefer the push-event msgIdx, falling back to the InputNotify refIdx.
        const inputNotifyRefIdx = await inputNotifyPromise;
        const currentMsgIdx = event.msgIdx ?? inputNotifyRefIdx;
        if (currentMsgIdx) {
          const attSummaries = buildAttachmentSummaries(event.attachments, attachmentLocalPaths);
          // Attach voice transcript metadata to the matching attachment summaries.
          if (attSummaries && voiceTranscripts.length > 0) {
            let voiceIdx = 0;
            for (const att of attSummaries) {
              if (att.type === "voice" && voiceIdx < voiceTranscripts.length) {
                att.transcript = voiceTranscripts[voiceIdx];
                if (voiceIdx < voiceTranscriptSources.length) {
                  att.transcriptSource = voiceTranscriptSources[voiceIdx];
                }
                voiceIdx++;
              }
            }
          }
          setRefIndex(currentMsgIdx, {
            content: parsedContent,
            senderId: event.senderId,
            senderName: event.senderName,
            timestamp: new Date(event.timestamp).getTime(),
            attachments: attSummaries,
          });
          log?.info(
            `[qqbot:${account.accountId}] Cached msgIdx=${currentMsgIdx} for future reference (source: ${event.msgIdx ? "message_scene.ext" : "InputNotify"})`,
          );
        }

        // Body is the user-visible raw message shown in the Web UI.
        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: isGroupChat ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });

        // BodyForAgent is the full model-visible context.
        const uniqueVoicePaths = [...new Set(voiceAttachmentPaths)];
        const uniqueVoiceUrls = [...new Set(voiceAttachmentUrls)];
        const uniqueVoiceAsrReferTexts = [...new Set(voiceAsrReferTexts)].filter(Boolean);
        const sttTranscriptCount = voiceTranscriptSources.filter((s) => s === "stt").length;
        const asrFallbackCount = voiceTranscriptSources.filter((s) => s === "asr").length;
        const fallbackCount = voiceTranscriptSources.filter((s) => s === "fallback").length;
        if (
          voiceAttachmentPaths.length > 0 ||
          voiceAttachmentUrls.length > 0 ||
          uniqueVoiceAsrReferTexts.length > 0
        ) {
          const asrPreview =
            uniqueVoiceAsrReferTexts.length > 0 ? uniqueVoiceAsrReferTexts[0].slice(0, 50) : "";
          log?.info(
            `[qqbot:${account.accountId}] Voice input summary: local=${uniqueVoicePaths.length}, remote=${uniqueVoiceUrls.length}, ` +
              `asrReferTexts=${uniqueVoiceAsrReferTexts.length}, transcripts=${voiceTranscripts.length}, ` +
              `source(stt/asr/fallback)=${sttTranscriptCount}/${asrFallbackCount}/${fallbackCount}` +
              (asrPreview
                ? `, asr_preview="${asrPreview}${uniqueVoiceAsrReferTexts[0].length > 50 ? "..." : ""}"`
                : ""),
          );
        }
        const qualifiedTarget = isGroupChat
          ? event.type === "guild"
            ? `qqbot:channel:${event.channelId}`
            : `qqbot:group:${event.groupOpenid}`
          : event.type === "dm"
            ? `qqbot:dm:${event.guildId}`
            : `qqbot:c2c:${event.senderId}`;

        const hasTTS =
          !!resolveTTSConfig(cfg as Record<string, unknown>) || isGlobalTTSAvailable(cfg);

        let quotePart = "";
        if (replyToIsQuote) {
          if (replyToBody) {
            quotePart = `[Quoted message begins]\n${replyToBody}\n[Quoted message ends]\n`;
          } else {
            quotePart = `[Quoted message begins]\nOriginal content unavailable\n[Quoted message ends]\n`;
          }
        }

        const staticParts: string[] = [`[QQBot] to=${qualifiedTarget}`];
        if (hasTTS) {
          staticParts.push("voice synthesis enabled");
        }
        const staticInstruction = staticParts.join(" | ");
        systemPrompts.unshift(staticInstruction);

        const dynLines: string[] = [];
        if (imageUrls.length > 0) {
          dynLines.push(`- Images: ${imageUrls.join(", ")}`);
        }
        if (uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
          dynLines.push(`- Voice: ${[...uniqueVoicePaths, ...uniqueVoiceUrls].join(", ")}`);
        }
        if (uniqueVoiceAsrReferTexts.length > 0) {
          dynLines.push(`- ASR: ${uniqueVoiceAsrReferTexts.join(" | ")}`);
        }
        const dynamicCtx = dynLines.length > 0 ? dynLines.join("\n") + "\n" : "";

        const userMessage = `${quotePart}${userContent}`;
        const agentBody = userContent.startsWith("/")
          ? userContent
          : `${systemPrompts.join("\n")}\n\n${dynamicCtx}${userMessage}`;

        log?.info(`[qqbot:${account.accountId}] agentBody length: ${agentBody.length}`);

        const fromAddress =
          event.type === "guild"
            ? `qqbot:channel:${event.channelId}`
            : event.type === "group"
              ? `qqbot:group:${event.groupOpenid}`
              : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

        const rawAllowFrom = account.config?.allowFrom ?? [];
        const normalizedAllowFrom = formatQQBotAllowFrom({
          allowFrom: rawAllowFrom,
        });
        const normalizedSenderId = event.senderId.replace(/^qqbot:/i, "").toUpperCase();
        const allowAll =
          normalizedAllowFrom.length === 0 || normalizedAllowFrom.some((e) => e === "*");
        const commandAuthorized = allowAll || normalizedAllowFrom.includes(normalizedSenderId);

        // Split local media paths from remote URLs for framework-native media handling.
        const localMediaPaths: string[] = [];
        const localMediaTypes: string[] = [];
        const remoteMediaUrls: string[] = [];
        const remoteMediaTypes: string[] = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const u = imageUrls[i];
          const t = imageMediaTypes[i] ?? "image/png";
          if (u.startsWith("http://") || u.startsWith("https://")) {
            remoteMediaUrls.push(u);
            remoteMediaTypes.push(t);
          } else {
            localMediaPaths.push(u);
            localMediaTypes.push(t);
          }
        }

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroupChat ? "group" : "direct",
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          QQChannelId: event.channelId,
          QQGuildId: event.guildId,
          QQGroupOpenid: event.groupOpenid,
          QQVoiceAsrReferAvailable: hasAsrReferFallback,
          QQVoiceTranscriptSources: voiceTranscriptSources,
          QQVoiceAttachmentPaths: uniqueVoicePaths,
          QQVoiceAttachmentUrls: uniqueVoiceUrls,
          QQVoiceAsrReferTexts: uniqueVoiceAsrReferTexts,
          QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
          CommandAuthorized: commandAuthorized,
          ...(localMediaPaths.length > 0
            ? {
                MediaPaths: localMediaPaths,
                MediaPath: localMediaPaths[0],
                MediaTypes: localMediaTypes,
                MediaType: localMediaTypes[0],
              }
            : {}),
          ...(remoteMediaUrls.length > 0
            ? {
                MediaUrls: remoteMediaUrls,
                MediaUrl: remoteMediaUrls[0],
              }
            : {}),
          ...(replyToId
            ? {
                ReplyToId: replyToId,
                ReplyToBody: replyToBody,
                ReplyToSender: replyToSender,
                ReplyToIsQuote: replyToIsQuote,
              }
            : {}),
        });

        const replyTarget: MessageTarget = {
          type: event.type,
          senderId: event.senderId,
          messageId: event.messageId,
          channelId: event.channelId,
          guildId: event.guildId,
          groupOpenid: event.groupOpenid,
        };
        const replyCtx: ReplyContext = { target: replyTarget, account, cfg, log };

        const sendWithRetry = <T>(sendFn: (token: string) => Promise<T>) =>
          sendWithTokenRetry(account.appId, account.clientSecret, sendFn, log, account.accountId);

        const sendErrorMessage = (errorText: string) => sendErrorToTarget(replyCtx, errorText);

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(
            cfg,
            route.agentId,
          );

          let hasResponse = false;
          let hasBlockResponse = false;
          let toolDeliverCount = 0;
          const toolTexts: string[] = [];
          const toolMediaUrls: string[] = [];
          let toolFallbackSent = false;
          const responseTimeout = 120000;
          const toolOnlyTimeout = 60000;
          const maxToolRenewals = 3;
          let toolRenewalCount = 0;
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

          const sendToolFallback = async (): Promise<void> => {
            if (toolMediaUrls.length > 0) {
              log?.info(
                `[qqbot:${account.accountId}] Tool fallback: forwarding ${toolMediaUrls.length} media URL(s) from tool deliver(s)`,
              );
              const mediaTimeout = 45000; // Per-media timeout: 45s.
              for (const mediaUrl of toolMediaUrls) {
                const ac = new AbortController();
                try {
                  const result = await Promise.race([
                    sendMediaAuto({
                      to: qualifiedTarget,
                      text: "",
                      mediaUrl,
                      accountId: account.accountId,
                      replyToId: event.messageId,
                      account,
                    }).then((r) => {
                      if (ac.signal.aborted) {
                        log?.info(
                          `[qqbot:${account.accountId}] Tool fallback sendMedia completed after timeout, suppressing late delivery`,
                        );
                        return {
                          channel: "qqbot",
                          error: "Media send completed after timeout (suppressed)",
                        } as typeof r;
                      }
                      return r;
                    }),
                    new Promise<{ channel: string; error: string }>((resolve) =>
                      setTimeout(() => {
                        ac.abort();
                        resolve({
                          channel: "qqbot",
                          error: `Tool fallback media send timeout (${mediaTimeout / 1000}s)`,
                        });
                      }, mediaTimeout),
                    ),
                  ]);
                  if (result.error) {
                    log?.error(
                      `[qqbot:${account.accountId}] Tool fallback sendMedia error: ${result.error}`,
                    );
                  }
                } catch (err) {
                  log?.error(
                    `[qqbot:${account.accountId}] Tool fallback sendMedia failed: ${
                      err instanceof Error ? err.message : JSON.stringify(err)
                    }`,
                  );
                }
              }
              return;
            }
            if (toolTexts.length > 0) {
              const text = toolTexts.slice(-3).join("\n---\n").slice(0, 2000);
              log?.info(
                `[qqbot:${account.accountId}] Tool fallback: forwarding tool text (${text.length} chars)`,
              );
              await sendErrorMessage(text);
              return;
            }
            log?.info(
              `[qqbot:${account.accountId}] Tool fallback: no media or text collected from ${toolDeliverCount} tool deliver(s), silently dropping`,
            );
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          const dispatchPromise =
            pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                responsePrefix: messagesConfig.responsePrefix,
                deliver: async (
                  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
                  info: { kind: string },
                ) => {
                  hasResponse = true;

                  log?.info(
                    `[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`,
                  );

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
                    log?.info(
                      `[qqbot:${account.accountId}] Collected tool deliver #${toolDeliverCount}: text=${toolText.length} chars, media=${toolMediaUrls.length} URLs`,
                    );

                    if (hasBlockResponse && toolMediaUrls.length > 0) {
                      log?.info(
                        `[qqbot:${account.accountId}] Block already sent, immediately forwarding ${toolMediaUrls.length} tool media URL(s)`,
                      );
                      const urlsToSend = [...toolMediaUrls];
                      toolMediaUrls.length = 0;
                      for (const mediaUrl of urlsToSend) {
                        try {
                          const result = await sendMediaAuto({
                            to: qualifiedTarget,
                            text: "",
                            mediaUrl,
                            accountId: account.accountId,
                            replyToId: event.messageId,
                            account,
                          });
                          if (result.error) {
                            log?.error(
                              `[qqbot:${account.accountId}] Tool media immediate forward error: ${result.error}`,
                            );
                          } else {
                            log?.info(
                              `[qqbot:${account.accountId}] Forwarded tool media (post-block): ${mediaUrl.slice(0, 80)}...`,
                            );
                          }
                        } catch (err) {
                          log?.error(
                            `[qqbot:${account.accountId}] Tool media immediate forward failed: ${
                              err instanceof Error ? err.message : JSON.stringify(err)
                            }`,
                          );
                        }
                      }
                      return;
                    }

                    if (toolFallbackSent) {
                      return;
                    }

                    if (toolOnlyTimeoutId) {
                      if (toolRenewalCount < maxToolRenewals) {
                        clearTimeout(toolOnlyTimeoutId);
                        toolRenewalCount++;
                        log?.info(
                          `[qqbot:${account.accountId}] Tool-only timer renewed (${toolRenewalCount}/${maxToolRenewals})`,
                        );
                      } else {
                        log?.info(
                          `[qqbot:${account.accountId}] Tool-only timer renewal limit reached (${maxToolRenewals}), waiting for timeout`,
                        );
                        return;
                      }
                    }
                    toolOnlyTimeoutId = setTimeout(async () => {
                      if (!hasBlockResponse && !toolFallbackSent) {
                        toolFallbackSent = true;
                        log?.error(
                          `[qqbot:${account.accountId}] Tool-only timeout: ${toolDeliverCount} tool deliver(s) but no block within ${toolOnlyTimeout / 1000}s, sending fallback`,
                        );
                        try {
                          await sendToolFallback();
                        } catch (sendErr) {
                          log?.error(
                            `[qqbot:${account.accountId}] Failed to send tool-only fallback: ${
                              sendErr instanceof Error ? sendErr.message : JSON.stringify(sendErr)
                            }`,
                          );
                        }
                      }
                    }, toolOnlyTimeout);
                    return;
                  }

                  hasBlockResponse = true;
                  typing.keepAlive?.stop();
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                  }
                  if (toolOnlyTimeoutId) {
                    clearTimeout(toolOnlyTimeoutId);
                    toolOnlyTimeoutId = null;
                  }
                  if (toolDeliverCount > 0) {
                    log?.info(
                      `[qqbot:${account.accountId}] Block deliver after ${toolDeliverCount} tool deliver(s)`,
                    );
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

                  const deliverEvent: DeliverEventContext = {
                    type: event.type,
                    senderId: event.senderId,
                    messageId: event.messageId,
                    channelId: event.channelId,
                    groupOpenid: event.groupOpenid,
                    msgIdx: event.msgIdx,
                  };
                  const deliverActx: DeliverAccountContext = { account, qualifiedTarget, log };

                  const mediaResult = await parseAndSendMediaTags(
                    replyText,
                    deliverEvent,
                    deliverActx,
                    sendWithRetry,
                    consumeQuoteRef,
                  );
                  if (mediaResult.handled) {
                    pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                    return;
                  }
                  replyText = mediaResult.normalizedText;

                  const recordOutboundActivity = () =>
                    pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                  const handled = await handleStructuredPayload(
                    replyCtx,
                    replyText,
                    recordOutboundActivity,
                  );
                  if (handled) {
                    return;
                  }

                  await sendPlainReply(
                    payload,
                    replyText,
                    deliverEvent,
                    deliverActx,
                    sendWithRetry,
                    consumeQuoteRef,
                    toolMediaUrls,
                  );

                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                },
                onError: async (err: unknown) => {
                  const errMsg =
                    err instanceof Error
                      ? err.message
                      : typeof err === "string"
                        ? err
                        : JSON.stringify(err);
                  log?.error(`[qqbot:${account.accountId}] Dispatch error: ${errMsg}`);
                  hasResponse = true;
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                  }
                  if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                    log?.error(`[qqbot:${account.accountId}] AI auth error: ${errMsg}`);
                  } else {
                    log?.error(`[qqbot:${account.accountId}] AI process error: ${errMsg}`);
                  }
                },
              },
              replyOptions: {
                disableBlockStreaming: account.config.streaming?.mode === "off",
              },
            });

          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (!hasResponse) {
              log?.error(`[qqbot:${account.accountId}] No response within timeout`);
            }
          } finally {
            if (toolOnlyTimeoutId) {
              clearTimeout(toolOnlyTimeoutId);
              toolOnlyTimeoutId = null;
            }
            if (toolDeliverCount > 0 && !hasBlockResponse && !toolFallbackSent) {
              toolFallbackSent = true;
              log?.error(
                `[qqbot:${account.accountId}] Dispatch completed with ${toolDeliverCount} tool deliver(s) but no block deliver, sending fallback`,
              );
              await sendToolFallback();
            }
          }
        } catch (err) {
          const errMsg =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : JSON.stringify(err);
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${errMsg}`);
        } finally {
          typing.keepAlive?.stop();
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false;
        reconnectAttempts = 0;
        lastConnectTime = Date.now();
        msgQueue.startProcessor(handleMessage);
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as {
            info: (msg: string) => void;
            error: (msg: string) => void;
            debug?: (msg: string) => void;
          },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = decodeGatewayMessageData(data);
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: 0,
                accountId: account.accountId,
                savedAt: Date.now(),
                appId: account.appId,
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);

              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(
                  JSON.stringify({
                    op: 6, // Resume
                    d: {
                      token: `QQBot ${accessToken}`,
                      session_id: sessionId,
                      seq: lastSeq,
                    },
                  }),
                );
              } else {
                log?.info(
                  `[qqbot:${account.accountId}] Sending identify with intents: ${FULL_INTENTS} (${FULL_INTENTS_DESC})`,
                );
                ws.send(
                  JSON.stringify({
                    op: 2,
                    d: {
                      token: `QQBot ${accessToken}`,
                      intents: FULL_INTENTS,
                      shard: [0, 1],
                    },
                  }),
                );
              }

              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
              }
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              log?.info(
                `[qqbot:${account.accountId}] 📩 Dispatch event: t=${t}, d=${JSON.stringify(d)}`,
              );
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                log?.info(
                  `[qqbot:${account.accountId}] Ready with ${FULL_INTENTS_DESC}, session: ${sessionId}`,
                );
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex: 0,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                onReady?.(d); // Notify the framework so health monitoring sees the connection as recovered.
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: 0,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                    appId: account.appId,
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                recordKnownUser({
                  openid: event.author.user_openid,
                  type: "c2c",
                  accountId: account.accountId,
                });
                const c2cRefs = parseRefIndices(event.message_scene?.ext);
                void trySlashCommandOrEnqueue({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                  refMsgIdx: c2cRefs.refMsgIdx,
                  msgIdx: c2cRefs.msgIdx,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // Guild users cannot receive proactive C2C messages — skip known-user recording.
                const guildRefs = parseRefIndices(readOptionalMessageSceneExt(event));
                void trySlashCommandOrEnqueue({
                  type: "guild",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  channelId: event.channel_id,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                  refMsgIdx: guildRefs.refMsgIdx,
                  msgIdx: guildRefs.msgIdx,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // DM author.id is a guild-scoped ID, not a C2C openid — skip known-user recording.
                const dmRefs = parseRefIndices(readOptionalMessageSceneExt(event));
                void trySlashCommandOrEnqueue({
                  type: "dm",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                  refMsgIdx: dmRefs.refMsgIdx,
                  msgIdx: dmRefs.msgIdx,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const event = d as GroupMessageEvent;
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: "group",
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                const groupRefs = parseRefIndices(event.message_scene?.ext);
                void trySlashCommandOrEnqueue({
                  type: "group",
                  senderId: event.author.member_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                  refMsgIdx: groupRefs.refMsgIdx,
                  msgIdx: groupRefs.msgIdx,
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              log?.error(
                `[qqbot:${account.accountId}] Invalid session (${FULL_INTENTS_DESC}), can resume: ${canResume}, raw: ${rawData}`,
              );

              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                clearSession(account.accountId);
                shouldRefreshToken = true;
                log?.info(
                  `[qqbot:${account.accountId}] Will refresh token and retry with full intents (${FULL_INTENTS_DESC})`,
                );
              }
              cleanup();
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(
            `[qqbot:${account.accountId}] Message parse error: ${
              err instanceof Error ? err.message : JSON.stringify(err)
            }`,
          );
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // Release the connect lock.

        if (code === 4914 || code === 4915) {
          log?.error(
            `[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`,
          );
          cleanup();
          return;
        }

        if (code === 4004) {
          log?.info(
            `[qqbot:${account.accountId}] Invalid token (4004), will refresh token and reconnect`,
          );
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) {
            scheduleReconnect();
          }
          return;
        }

        if (code === 4008) {
          log?.info(
            `[qqbot:${account.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms before reconnect`,
          );
          cleanup();
          if (!isAborted) {
            scheduleReconnect(RATE_LIMIT_DELAY);
          }
          return;
        }

        if (code === 4006 || code === 4007 || code === 4009) {
          const codeDesc: Record<number, string> = {
            4006: "session no longer valid",
            4007: "invalid seq on resume",
            4009: "session timed out",
          };
          log?.info(
            `[qqbot:${account.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`,
          );
          sessionId = null;
          lastSeq = null;
          clearSession(account.accountId);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }

        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(
            `[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`,
          );

          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(
              `[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`,
            );
            log?.error(
              `[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`,
            );
            quickDisconnectCount = 0;
            cleanup();
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          quickDisconnectCount = 0;
        }

        cleanup();

        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });
    } catch (err) {
      isConnecting = false;
      const errMsg = err instanceof Error ? err.message : (JSON.stringify(err) ?? "Unknown error");
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${errMsg}`);
      // Back off more aggressively after rate-limit failures.
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(
          `[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`,
        );
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  await connect();

  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
