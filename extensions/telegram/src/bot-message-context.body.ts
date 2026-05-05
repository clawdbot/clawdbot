import {
  buildMentionRegexes,
  formatLocationText,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-types";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { isSenderAllowed } from "./bot-access.js";
import type {
  TelegramLogger,
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildSenderLabel,
  buildSenderName,
  expandTextLinks,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  resolveTelegramPrimaryMedia,
} from "./bot/body-helpers.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";

type StickerVisionRuntime = typeof import("./sticker-vision.runtime.js");
type MediaUnderstandingRuntime = typeof import("./media-understanding.runtime.js");

let stickerVisionRuntimePromise: Promise<StickerVisionRuntime> | undefined;
let mediaUnderstandingRuntimePromise: Promise<MediaUnderstandingRuntime> | undefined;

function loadStickerVisionRuntime(): Promise<StickerVisionRuntime> {
  stickerVisionRuntimePromise ??= import("./sticker-vision.runtime.js");
  return stickerVisionRuntimePromise;
}

function loadMediaUnderstandingRuntime(): Promise<MediaUnderstandingRuntime> {
  mediaUnderstandingRuntimePromise ??= import("./media-understanding.runtime.js");
  return mediaUnderstandingRuntimePromise;
}

export type TelegramInboundBodyResult = {
  bodyText: string;
  rawBody: string;
  historyKey?: string;
  commandAuthorized: boolean;
  effectiveWasMentioned: boolean;
  canDetectMention: boolean;
  shouldBypassMention: boolean;
  audioTranscribedMediaIndex?: number;
  stickerCacheHit: boolean;
  locationData?: NormalizedLocation;
};

function formatAudioTranscriptForAgent(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}

type TelegramSavedMediaKind = "audio" | "document" | "image" | "video";

function resolveSavedMediaKind(contentType: string | undefined): TelegramSavedMediaKind {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized?.startsWith("audio/")) {
    return "audio";
  }
  if (normalized?.startsWith("image/")) {
    return "image";
  }
  if (normalized?.startsWith("video/")) {
    return "video";
  }
  return "document";
}

function formatSavedMediaPlaceholder(allMedia: TelegramMediaRef[]): string | undefined {
  if (allMedia.length === 0) {
    return undefined;
  }
  const kinds = allMedia.map((media) => resolveSavedMediaKind(media.contentType));
  const firstKind = kinds[0] ?? "document";
  const kind = kinds.every((candidate) => candidate === firstKind) ? firstKind : "document";
  if (allMedia.length === 1) {
    return `<media:${kind}>`;
  }
  if (kind === "image") {
    return `<media:image> (${allMedia.length} images)`;
  }
  if (kind === "video") {
    return `<media:video> (${allMedia.length} videos)`;
  }
  if (kind === "audio") {
    return `<media:audio> (${allMedia.length} audio attachments)`;
  }
  return `<media:document> (${allMedia.length} attachments)`;
}

async function resolveStickerVisionSupport(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<boolean> {
  try {
    const { resolveStickerVisionSupportRuntime } = await loadStickerVisionRuntime();
    return await resolveStickerVisionSupportRuntime(params);
  } catch {
    return false;
  }
}

export async function resolveTelegramInboundBody(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  isGroup: boolean;
  chatId: number | string;
  accountId?: string;
  senderId: string;
  senderUsername: string;
  sessionKey?: string;
  resolvedThreadId?: number;
  replyThreadId?: number;
  routeAgentId?: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  requireMention?: boolean;
  options?: TelegramMessageContextOptions;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  logger: TelegramLogger;
}): Promise<TelegramInboundBodyResult | null> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    accountId,
    senderId,
    senderUsername,
    sessionKey,
    resolvedThreadId,
    replyThreadId,
    routeAgentId,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    requireMention,
    options,
    groupHistories,
    historyLimit,
    logger,
  } = params;
  const botUsername = normalizeOptionalLowercaseString(primaryCtx.me?.username);
  const mentionRegexes = buildMentionRegexes(cfg, routeAgentId);
  const messageTextParts = getTelegramTextParts(msg);
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const senderAllowedForCommands = isSenderAllowed({
    allow: allowForCommands,
    senderId,
    senderUsername,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, {
    botUsername,
  });
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [{ configured: allowForCommands.hasEntries, allowed: senderAllowedForCommands }],
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : undefined;

  const primaryMedia = resolveTelegramPrimaryMedia(msg);
  let placeholder = primaryMedia?.placeholder ?? "";
  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerSupportsVision = msg.sticker
    ? await resolveStickerVisionSupport({ cfg, agentId: routeAgentId })
    : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  if (stickerCacheHit) {
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    placeholder = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const rawText = expandTextLinks(messageTextParts.text, messageTextParts.entities).trim();
  const hasUserText = Boolean(rawText || locationText);
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    rawBody = placeholder;
  }
  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  let bodyText = rawBody;
  if (allMedia.length === 0 && placeholder && rawBody !== placeholder) {
    const mediaTag = primaryMedia?.fileRef.file_id
      ? `${placeholder} [file_id:${primaryMedia.fileRef.file_id}]`
      : placeholder;
    bodyText = `${mediaTag}\n${bodyText}`.trim();
  }
  const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));
  const disableAudioPreflight =
    (topicConfig?.disableAudioPreflight ??
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight) === true;
  const senderAllowedForAudioPreflight =
    !useAccessGroups || !allowForCommands.hasEntries || senderAllowedForCommands;

  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    hasAudio &&
    !hasUserText &&
    (!isGroup ||
      (requireMention &&
        mentionRegexes.length > 0 &&
        !disableAudioPreflight &&
        senderAllowedForAudioPreflight));

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await loadMediaUnderstandingRuntime();
      const tempCtx: MsgContext = {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: `telegram:${chatId}`,
        AccountId: accountId,
        MessageThreadId: replyThreadId,
        MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
        MediaTypes:
          allMedia.length > 0
            ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
            : undefined,
      };
      preflightTranscript = await transcribeFirstAudio({
        ctx: tempCtx,
        cfg,
        agentDir: undefined,
      });
    } catch (err) {
      logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
    }
  }
  const audioTranscribedMediaIndex =
    preflightTranscript === undefined
      ? undefined
      : allMedia.findIndex((media) => media.contentType?.startsWith("audio/"));

  if (hasAudio && bodyText === "<media:audio>" && preflightTranscript) {
    bodyText = formatAudioTranscriptForAgent(preflightTranscript);
  }

  const savedMediaPlaceholder = formatSavedMediaPlaceholder(allMedia);
  if (!hasAudio && savedMediaPlaceholder && placeholder && bodyText === placeholder) {
    bodyText = savedMediaPlaceholder;
  }
  if (!bodyText && allMedia.length > 0) {
    if (hasAudio) {
      bodyText = preflightTranscript
        ? formatAudioTranscriptForAgent(preflightTranscript)
        : "<media:audio>";
    } else {
      bodyText = savedMediaPlaceholder ?? "<media:document>";
    }
  }

  const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
  const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
  const computedWasMentioned = matchesMentionWithExplicit({
    text: messageTextParts.text,
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(botUsername),
    },
    transcript: preflightTranscript,
  });
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "control command (unauthorized)",
      target: senderId ?? "unknown",
    });
    return null;
  }

  const botId = primaryCtx.me?.id;
  const replyFromId = msg.reply_to_message?.from?.id;
  const replyToBotMessage = botId != null && replyFromId === botId;
  const isReplyToServiceMessage =
    replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    replyToBotMessage && !isReplyToServiceMessage,
  );
  const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds: isGroup && Boolean(requireMention) ? implicitMentionKinds : [],
    },
    policy: {
      isGroup,
      requireMention: Boolean(requireMention),
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
  if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
    logger.info({ chatId, reason: "no-mention" }, "skipping group message");
    recordPendingHistoryEntryIfEnabled({
      historyMap: groupHistories,
      historyKey: historyKey ?? "",
      limit: historyLimit,
      entry: historyKey
        ? {
            sender: buildSenderLabel(msg, senderId || chatId),
            body: rawBody,
            timestamp: msg.date ? msg.date * 1000 : undefined,
            messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
          }
        : null,
    });
    const telegramGroupPolicy = resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      groupId: String(chatId),
      accountId,
    });
    const ingestEnabled =
      topicConfig?.ingest ??
      telegramGroupPolicy.groupConfig?.ingest ??
      telegramGroupPolicy.defaultConfig?.ingest;
    if (ingestEnabled === true && sessionKey) {
      fireAndForgetHook(
        triggerInternalHook(
          createInternalHookEvent(
            "message",
            "received",
            sessionKey,
            toInternalMessageReceivedContext({
              from: `telegram:group:${historyKey ?? chatId}`,
              to: `telegram:${chatId}`,
              content: rawBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              channelId: "telegram",
              accountId,
              conversationId: `telegram:${chatId}`,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
              senderId: senderId || undefined,
              senderName: buildSenderName(msg),
              senderUsername: senderUsername || undefined,
              provider: "telegram",
              surface: "telegram",
              threadId: resolvedThreadId,
              originatingChannel: "telegram",
              originatingTo: `telegram:${chatId}`,
              isGroup: true,
              groupId: `telegram:${chatId}`,
            }),
          ),
        ),
        "telegram: mention-skip message hook failed",
      );
    }
    return null;
  }

  return {
    bodyText,
    rawBody,
    historyKey,
    commandAuthorized,
    effectiveWasMentioned,
    canDetectMention,
    shouldBypassMention: mentionDecision.shouldBypassMention,
    ...(audioTranscribedMediaIndex !== undefined && audioTranscribedMediaIndex >= 0
      ? { audioTranscribedMediaIndex }
      : {}),
    stickerCacheHit,
    locationData: locationData ?? undefined,
  };
}
