/**
 * Inbound pipeline — build a fully resolved InboundContext from a raw QueuedMessage.
 *
 * Responsibilities:
 * 1. Route resolution
 * 2. Attachment processing (download + STT)
 * 3. Content building (parseFaceTags + voiceText + attachmentInfo)
 * 4. Quote / reply-to resolution (three-level fallback)
 * 5. RefIdx cache write (setRefIndex)
 * 6. Body / agentBody / ctxPayload data assembly
 *
 * No message sending. Independently testable.
 */

import {
  normalizeQQBotSenderId,
  resolveQQBotAccess,
  QQBOT_ACCESS_REASON,
  type QQBotAccessResult,
} from "../access/index.js";
import {
  formatMessageReferenceForAgent,
  type AttachmentProcessor,
} from "../ref/format-message-ref.js";
import { getRefIndex, setRefIndex, formatRefEntryForAgent } from "../ref/store.js";
import { parseFaceTags, buildAttachmentSummaries, MSG_TYPE_QUOTE } from "../utils/text-parsing.js";
import { formatVoiceText } from "../utils/voice-text.js";
import { processAttachments } from "./inbound-attachments.js";
import type { InboundContext, InboundPipelineDeps } from "./inbound-context.js";
import type { QueuedMessage } from "./message-queue.js";

// ============ buildInboundContext ============

/**
 * Process a raw queued message through the full inbound pipeline and return
 * a structured {@link InboundContext} ready for outbound dispatch.
 */
export async function buildInboundContext(
  event: QueuedMessage,
  deps: InboundPipelineDeps,
): Promise<InboundContext> {
  const { account, cfg, log, runtime } = deps;

  // ---- 1. Route resolution ----
  const isGroupChat = event.type === "guild" || event.type === "group";
  const peerId =
    event.type === "guild"
      ? (event.channelId ?? "unknown")
      : event.type === "group"
        ? (event.groupOpenid ?? "unknown")
        : event.senderId;

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "qqbot",
    accountId: account.accountId,
    peer: { kind: isGroupChat ? "group" : "direct", id: peerId },
  });

  const qualifiedTarget = isGroupChat
    ? event.type === "guild"
      ? `qqbot:channel:${event.channelId}`
      : `qqbot:group:${event.groupOpenid}`
    : event.type === "dm"
      ? `qqbot:dm:${event.guildId}`
      : `qqbot:c2c:${event.senderId}`;
  const fromAddress = qualifiedTarget;

  const selfEchoAccess = resolveBotSelfEchoAccess(event, account.accountId);
  if (selfEchoAccess) {
    log?.info(
      `Blocked qqbot inbound self-echo: reasonCode=${selfEchoAccess.reasonCode} ` +
        `msgIdx=${event.msgIdx ?? ""} senderId=${normalizeQQBotSenderId(event.senderId)} ` +
        `accountId=${account.accountId} isGroup=${isGroupChat}`,
    );
    return buildBlockedInboundContext({
      event,
      route,
      isGroupChat,
      peerId,
      qualifiedTarget,
      fromAddress,
      access: selfEchoAccess,
    });
  }

  // ---- 1a. Early access control ----
  //
  // Evaluate the account-level dmPolicy / groupPolicy + allowFrom /
  // groupAllowFrom whitelist before any expensive I/O (typing
  // indicator, attachment downloads, quote resolution). Semantics are
  // aligned with WhatsApp/Telegram/Discord (see `engine/access/`).
  //
  // When blocked, we return a minimal stub InboundContext and rely on
  // the gateway handler to skip dispatch.
  const access = resolveQQBotAccess({
    isGroup: isGroupChat,
    senderId: event.senderId,
    allowFrom: account.config?.allowFrom,
    groupAllowFrom: account.config?.groupAllowFrom,
    dmPolicy: account.config?.dmPolicy,
    groupPolicy: account.config?.groupPolicy,
  });

  if (access.decision !== "allow") {
    log?.info(
      `Blocked qqbot inbound: decision=${access.decision} reasonCode=${access.reasonCode} ` +
        `reason=${access.reason} senderId=${normalizeQQBotSenderId(event.senderId)} ` +
        `accountId=${account.accountId} isGroup=${isGroupChat}`,
    );
    return buildBlockedInboundContext({
      event,
      route,
      isGroupChat,
      peerId,
      qualifiedTarget,
      fromAddress,
      access,
    });
  }

  // ---- 2. System prompts ----
  const systemPrompts: string[] = [];
  if (account.systemPrompt) {
    systemPrompts.push(account.systemPrompt);
  }

  // ---- 3. Typing indicator (async, await later) ----
  const typingPromise = deps.startTyping(event);

  // ---- 4. Attachment processing ----
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

  // ---- 5. Content building ----
  const voiceText = formatVoiceText(voiceTranscripts);
  const hasAsrReferFallback = voiceTranscriptSources.includes("asr");
  const parsedContent = parseFaceTags(event.content);
  const userContent = voiceText
    ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
    : parsedContent + attachmentInfo;

  // ---- 6. Quote / reply-to resolution ----
  const replyTo = await resolveQuote(event, account, cfg, log);

  // ---- 7. RefIdx cache write ----
  const typingResult = await typingPromise;
  const inputNotifyRefIdx = typingResult.refIdx;
  const currentMsgIdx = event.msgIdx ?? inputNotifyRefIdx;
  if (currentMsgIdx) {
    const attSummaries = buildAttachmentSummaries(event.attachments, attachmentLocalPaths);
    if (attSummaries && voiceTranscripts.length > 0) {
      let voiceIdx = 0;
      for (const att of attSummaries) {
        if (att.type === "voice" && voiceIdx < voiceTranscripts.length) {
          att.transcript = voiceTranscripts[voiceIdx];
          if (voiceIdx < voiceTranscriptSources.length) {
            att.transcriptSource = voiceTranscriptSources[voiceIdx] as
              | "stt"
              | "asr"
              | "tts"
              | "fallback";
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
  }

  // ---- 8. Envelope (Web UI body) ----
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatInboundEnvelope({
    channel: "qqbot",
    from: event.senderName ?? event.senderId,
    timestamp: new Date(event.timestamp).getTime(),
    body: userContent,
    chatType: isGroupChat ? "group" : "direct",
    sender: { id: event.senderId, name: event.senderName },
    envelope: envelopeOptions,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
  });

  // ---- 9. Voice dedup ----
  const uniqueVoicePaths = [...new Set(voiceAttachmentPaths)];
  const uniqueVoiceUrls = [...new Set(voiceAttachmentUrls)];
  const uniqueVoiceAsrReferTexts = [...new Set(voiceAsrReferTexts)].filter(Boolean);

  // ---- 11. Quote part ----
  let quotePart = "";
  if (replyTo) {
    quotePart = replyTo.body
      ? `[Quoted message begins]\n${replyTo.body}\n[Quoted message ends]\n`
      : `[Quoted message begins]\nOriginal content unavailable\n[Quoted message ends]\n`;
  }

  // ---- 12. Dynamic context ----
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
  const dynamicCtx = dynLines.length > 0 ? dynLines.join("\n") + "\n\n" : "";

  // ---- 13. agentBody ----
  const userMessage = `${quotePart}${userContent}`;
  const agentBody = userContent.startsWith("/") ? userContent : `${dynamicCtx}${userMessage}`;

  // ---- 14. GroupSystemPrompt ----
  const qqbotSystemInstruction = systemPrompts.length > 0 ? systemPrompts.join("\n") : "";
  const groupSystemPrompt = qqbotSystemInstruction || undefined;

  // ---- 15. Auth: commandAuthorized semantics ----
  //
  // `commandAuthorized=true` means the framework is allowed to honour
  // `/xxx` directives (e.g. `/exec host=... ask=...`) from this sender.
  //
  // We treat the sender as authorized when one of the following holds:
  //   - DM with policy=open  (the bot owner implicitly trusts DMs)
  //   - DM with policy=allowlist and sender matched
  //   - Group where the sender is explicitly in groupAllowFrom/allowFrom
  //     (matches the `allowlist (allowlisted)` reason string).
  //
  // Notably, a group running in `policy=open` does NOT grant command
  // authorization to arbitrary group members, aligning with the other
  // channel plugins (Telegram/WhatsApp/Discord) which require explicit
  // allowlist membership for command-level gating.
  const commandAuthorized =
    access.reasonCode === "dm_policy_open" ||
    access.reasonCode === "dm_policy_allowlisted" ||
    (access.reasonCode === "group_policy_allowed" &&
      access.effectiveGroupAllowFrom.length > 0 &&
      access.groupPolicy === "allowlist");

  // ---- 16. Media path classification ----
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
  const voiceMediaTypes = [...uniqueVoicePaths, ...uniqueVoiceUrls].map(() => "audio/wav");

  return {
    event,
    route,
    isGroupChat,
    peerId,
    qualifiedTarget,
    fromAddress,
    parsedContent,
    userContent,
    quotePart,
    dynamicCtx,
    userMessage,
    agentBody,
    body,
    systemPrompts,
    groupSystemPrompt,
    attachments: processed,
    localMediaPaths,
    localMediaTypes,
    remoteMediaUrls,
    remoteMediaTypes,
    uniqueVoicePaths,
    uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts,
    voiceMediaTypes,
    hasAsrReferFallback,
    voiceTranscriptSources,
    replyTo,
    commandAuthorized,
    blocked: false,
    accessDecision: access.decision,
    typing: { keepAlive: typingResult.keepAlive },
    inputNotifyRefIdx,
  };
}

/**
 * Build a stub InboundContext for blocked (unauthorized) messages.
 *
 * The gateway handler inspects `blocked` and skips outbound dispatch,
 * so most fields can be left empty. We still populate routing/peer
 * fields so logs and metrics remain meaningful.
 */
function buildBlockedInboundContext(params: {
  event: QueuedMessage;
  route: { sessionKey: string; accountId: string; agentId?: string };
  isGroupChat: boolean;
  peerId: string;
  qualifiedTarget: string;
  fromAddress: string;
  access: QQBotAccessResult;
}): InboundContext {
  const emptyProcessed: InboundContext["attachments"] = {
    attachmentInfo: "",
    imageUrls: [],
    imageMediaTypes: [],
    voiceAttachmentPaths: [],
    voiceAttachmentUrls: [],
    voiceAsrReferTexts: [],
    voiceTranscripts: [],
    voiceTranscriptSources: [],
    attachmentLocalPaths: [],
  };

  return {
    event: params.event,
    route: params.route,
    isGroupChat: params.isGroupChat,
    peerId: params.peerId,
    qualifiedTarget: params.qualifiedTarget,
    fromAddress: params.fromAddress,
    parsedContent: "",
    userContent: "",
    quotePart: "",
    dynamicCtx: "",
    userMessage: "",
    agentBody: "",
    body: "",
    systemPrompts: [],
    groupSystemPrompt: undefined,
    attachments: emptyProcessed,
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
    remoteMediaTypes: [],
    uniqueVoicePaths: [],
    uniqueVoiceUrls: [],
    uniqueVoiceAsrReferTexts: [],
    voiceMediaTypes: [],
    hasAsrReferFallback: false,
    voiceTranscriptSources: [],
    replyTo: undefined,
    commandAuthorized: false,
    blocked: true,
    blockReason: params.access.reason,
    blockReasonCode: params.access.reasonCode,
    accessDecision: params.access.decision,
    typing: { keepAlive: null },
    inputNotifyRefIdx: undefined,
  };
}

function resolveBotSelfEchoAccess(
  event: QueuedMessage,
  accountId: string,
): QQBotAccessResult | null {
  const currentMsgIdx = event.msgIdx?.trim();
  if (!currentMsgIdx) {
    return null;
  }

  // Only the current message ref is a self-echo signal. `refMsgIdx` points at
  // a quoted message, and real users must still be able to reply to bot output.
  const refEntry = getRefIndex(currentMsgIdx);
  if (refEntry?.isBot !== true || refEntry.senderId !== accountId) {
    return null;
  }

  return {
    decision: "block",
    reasonCode: QQBOT_ACCESS_REASON.BOT_SELF_ECHO,
    reason: "bot self-echo",
    effectiveAllowFrom: [],
    effectiveGroupAllowFrom: [],
    dmPolicy: "open",
    groupPolicy: "open",
  };
}

// ============ Quote resolution (internal) ============

async function resolveQuote(
  event: QueuedMessage,
  account: InboundPipelineDeps["account"],
  cfg: unknown,
  log?: InboundPipelineDeps["log"],
): Promise<InboundContext["replyTo"]> {
  if (!event.refMsgIdx) {
    return undefined;
  }

  const refEntry = getRefIndex(event.refMsgIdx);

  if (refEntry) {
    log?.debug?.(
      `Quote detected via refMsgIdx cache: refMsgIdx=${event.refMsgIdx}, sender=${refEntry.senderName ?? refEntry.senderId}`,
    );
    return {
      id: event.refMsgIdx,
      body: formatRefEntryForAgent(refEntry),
      sender: refEntry.senderName ?? refEntry.senderId,
      isQuote: true,
    };
  }

  if (event.msgType === MSG_TYPE_QUOTE && event.msgElements?.[0]) {
    try {
      const refElement = event.msgElements[0];
      const refData = {
        content: refElement.content ?? "",
        attachments: refElement.attachments,
      };
      const attachmentProcessor: AttachmentProcessor = {
        processAttachments: async (atts, refCtx) => {
          const result = await processAttachments(
            atts as Array<{
              content_type: string;
              url: string;
              filename?: string;
              voice_wav_url?: string;
              asr_refer_text?: string;
            }>,
            {
              accountId: account.accountId,
              cfg: refCtx.cfg,
              log: refCtx.log,
            },
          );
          return {
            attachmentInfo: result.attachmentInfo,
            voiceTranscripts: result.voiceTranscripts,
            voiceTranscriptSources: result.voiceTranscriptSources,
            attachmentLocalPaths: result.attachmentLocalPaths,
          };
        },
        formatVoiceText: (transcripts) => formatVoiceText(transcripts),
      };
      const refPeerId =
        event.type === "group" && event.groupOpenid ? event.groupOpenid : event.senderId;
      const refBody = await formatMessageReferenceForAgent(
        refData,
        { appId: account.appId, peerId: refPeerId, cfg: account.config, log },
        attachmentProcessor,
      );
      log?.debug?.(
        `Quote detected via msg_elements[0] (cache miss): id=${event.refMsgIdx}, content="${(refBody ?? "").slice(0, 80)}..."`,
      );
      return {
        id: event.refMsgIdx,
        body: refBody || undefined,
        isQuote: true,
      };
    } catch (refErr) {
      log?.error(`Failed to format quoted message from msg_elements: ${String(refErr)}`);
    }
  } else {
    log?.debug?.(
      `Quote detected but no cache and msgType=${event.msgType}: refMsgIdx=${event.refMsgIdx}`,
    );
  }

  return {
    id: event.refMsgIdx,
    isQuote: true,
  };
}
