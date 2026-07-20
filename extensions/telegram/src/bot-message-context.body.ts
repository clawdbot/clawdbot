// Telegram plugin module implements bot message context.body behavior.
import {
  buildMentionRegexes,
  classifyChannelInboundEvent,
  formatMediaPlaceholderText,
  formatLocationText,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
  resolveUnmentionedGroupInboundPolicy,
  type BuildChannelInboundEventContextParams,
  type BuildMentionRegexesOptions,
  type InboundEventKind,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type {
  TelegramLogger,
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildSenderLabel,
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMentionInText,
  hasBotMention,
  renderTelegramTextEntities,
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessagePlaceholder,
  resolveTelegramRichMessageText,
} from "./bot/body-helpers.js";
import { buildTelegramGroupPeerId, buildTelegramInboundOriginTarget } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { recordTelegramGroupHistoryEntry } from "./group-history-window.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
type TelegramMentionFacts = NonNullable<
  NonNullable<BuildChannelInboundEventContextParams["access"]>["mentions"]
>;

const loadStickerVisionRuntime = createLazyRuntimeModule(
  () => import("./sticker-vision.runtime.js"),
);

const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("./media-understanding.runtime.js"),
);

type TelegramInboundBodyResult = {
  bodyText: string;
  rawBody: string;
  historyKey?: string;
  commandAuthorized: boolean;
  effectiveWasMentioned: boolean;
  mentionFacts: TelegramMentionFacts;
  inboundEventKind: InboundEventKind;
  canDetectMention: boolean;
  shouldBypassMention: boolean;
  hasControlCommand: boolean;
  audioTranscribedMediaIndex?: number;
  stickerCacheHit: boolean;
  locationData?: NormalizedLocation;
};

function formatAudioTranscriptForAgent(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}

function resolveTelegramMentionFacts(params: {
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  explicitlyMentionedBot: boolean;
  computedWasMentioned: boolean;
  implicitMentionKinds: TelegramMentionFacts["implicitMentionKinds"];
  requireMention: boolean;
  shouldBypassMention: boolean;
}): TelegramMentionFacts {
  let mentionSource: TelegramMentionFacts["mentionSource"];
  if (params.explicitlyMentionedBot) {
    mentionSource = "explicit_bot";
  } else if (params.computedWasMentioned) {
    mentionSource = "mention_pattern";
  } else if (params.implicitMentionKinds && params.implicitMentionKinds.length > 0) {
    mentionSource = "implicit_thread";
  } else if (params.shouldBypassMention) {
    mentionSource = "command_bypass";
  }

  return {
    canDetectMention: params.canDetectMention,
    wasMentioned: params.effectiveWasMentioned,
    explicitlyMentionedBot: params.explicitlyMentionedBot,
    mentionSource,
    implicitMentionKinds: params.implicitMentionKinds,
    effectiveWasMentioned: params.effectiveWasMentioned,
    requireMention: params.requireMention,
  };
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
  originatingTo?: string;
  routeAgentId?: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  providerMentionPatterns?: BuildMentionRegexesOptions["providerPolicy"];
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
    originatingTo: providedOriginatingTo,
    routeAgentId,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    providerMentionPatterns,
    requireMention,
    options,
    groupHistories,
    historyLimit,
    logger,
  } = params;
  const botUsername = normalizeOptionalLowercaseString(primaryCtx.me?.username);
  const mentionRegexes = buildMentionRegexes(cfg, routeAgentId, {
    provider: "telegram",
    conversationId: isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId),
    providerPolicy: providerMentionPatterns,
  });
  const messageTextParts = getTelegramTextParts(msg);
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, {
    botUsername,
  });
  const commandGate = await resolveTelegramCommandIngressAuthorization({
    accountId: accountId ?? "default",
    cfg,
    dmPolicy: "pairing",
    isGroup,
    chatId,
    resolvedThreadId,
    senderId,
    effectiveDmAllow,
    effectiveGroupAllow,
    ownerAccess: { ownerList: [], senderIsOwner: false },
    eventKind: "message",
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    modeWhenAccessGroupsOff: "allow",
    includeDmAllowForGroupCommands: false,
  });
  const commandAuthorized = commandGate.authorized;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : undefined;
  const originatingTo = providedOriginatingTo ?? buildTelegramInboundOriginTarget(chatId);

  const primaryMedia = resolveTelegramPrimaryMedia(msg);
  const nativeMediaFacts =
    allMedia.length > 0 ? allMedia : primaryMedia ? [{ kind: primaryMedia.kind }] : [];
  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerSupportsVision =
    msg.sticker && allMedia.some((media) => media.kind === "sticker" && media.path)
      ? await resolveStickerVisionSupport({ cfg, agentId: routeAgentId })
      : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  let formattedStickerDescription: string | undefined;
  if (stickerCacheHit) {
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    formattedStickerDescription = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const rawText = renderTelegramTextEntities(
    messageTextParts.text,
    messageTextParts.entities,
  ).trim();
  const richText = resolveTelegramRichMessageText(msg);
  const hasUserText = Boolean(rawText || locationText);
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    rawBody = richText ?? resolveTelegramRichMessagePlaceholder(msg) ?? "";
  }
  if (!rawBody && nativeMediaFacts.length === 0) {
    return null;
  }

  let bodyText = rawBody;
  if (formattedStickerDescription) {
    bodyText = [formattedStickerDescription, rawBody].filter(Boolean).join("\n");
  }
  const isAudioMedia = (media: TelegramMediaRef) =>
    media.kind === "audio" || media.contentType?.startsWith("audio/") === true;
  const hasAudio = nativeMediaFacts.some(isAudioMedia);
  const materializedMedia = allMedia.filter((media) => Boolean(media.path));
  const materializedAudioIndex = allMedia.findIndex(
    (media) => Boolean(media.path) && isAudioMedia(media),
  );
  const disableAudioPreflight =
    (topicConfig?.disableAudioPreflight ??
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight) === true;
  const senderAllowedForAudioPreflight =
    !useAccessGroups || !allowForCommands.hasEntries || commandAuthorized;

  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    hasAudio &&
    materializedAudioIndex >= 0 &&
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
        OriginatingTo: originatingTo,
        AccountId: accountId,
        MessageThreadId: replyThreadId,
        MediaPaths:
          materializedMedia.length > 0
            ? materializedMedia.map((media) => media.path as string)
            : undefined,
        MediaTypes:
          materializedMedia.length > 0
            ? materializedMedia.map((media) => media.contentType ?? media.kind)
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
    preflightTranscript === undefined ? undefined : materializedAudioIndex;

  if (hasAudio && !rawBody && preflightTranscript) {
    bodyText = formatAudioTranscriptForAgent(preflightTranscript);
  }
  const historyBody =
    rawBody || formattedStickerDescription || formatMediaPlaceholderText(nativeMediaFacts);

  const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
  const explicitlyMentioned = botUsername
    ? hasBotMention(msg, botUsername) ||
      (richText ? hasBotMentionInText(richText, botUsername) : false)
    : false;
  const computedWasMentioned = matchesMentionWithExplicit({
    text: messageTextParts.text || richText || "",
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(botUsername),
    },
    transcript: preflightTranscript,
  });
  const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;

  if (isGroup && commandGate.shouldBlockControlCommand) {
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
      implicitMentionKinds: isGroup ? implicitMentionKinds : [],
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
  const commandSource =
    options?.commandSource ??
    (commandAuthorized && hasControlCommandInMessage ? "text" : undefined);
  const inboundEventKind = classifyChannelInboundEvent({
    conversation: { kind: isGroup ? "group" : "direct" },
    unmentionedGroupPolicy: resolveUnmentionedGroupInboundPolicy({
      cfg,
      agentId: routeAgentId,
    }),
    wasMentioned: effectiveWasMentioned,
    hasControlCommand: hasControlCommandInMessage,
    hasAbortRequest: isAbortRequestText(rawBody, { botUsername }),
    commandSource,
  });
  if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
    logger.info({ chatId, reason: "no-mention" }, "skipping group message");
    recordTelegramGroupHistoryEntry({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      entry: {
        sender: buildSenderLabel(msg, senderId || chatId),
        body: historyBody,
        timestamp: msg.date ? msg.date * 1000 : undefined,
        messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
      },
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
              to: originatingTo,
              content: rawBody,
              timestamp: msg.date ? msg.date * 1000 : undefined,
              channelId: "telegram",
              accountId,
              conversationId: originatingTo,
              messageId: typeof msg.message_id === "number" ? String(msg.message_id) : undefined,
              senderId: senderId || undefined,
              senderName: buildSenderName(msg),
              senderUsername: senderUsername || undefined,
              provider: "telegram",
              surface: "telegram",
              threadId: resolvedThreadId,
              originatingChannel: "telegram",
              originatingTo,
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
    inboundEventKind,
    mentionFacts: resolveTelegramMentionFacts({
      canDetectMention,
      effectiveWasMentioned,
      explicitlyMentionedBot: explicitlyMentioned,
      computedWasMentioned,
      implicitMentionKinds,
      requireMention: Boolean(requireMention),
      shouldBypassMention: mentionDecision.shouldBypassMention,
    }),
    canDetectMention,
    shouldBypassMention: mentionDecision.shouldBypassMention,
    hasControlCommand: hasControlCommandInMessage,
    ...(audioTranscribedMediaIndex !== undefined && audioTranscribedMediaIndex >= 0
      ? { audioTranscribedMediaIndex }
      : {}),
    stickerCacheHit,
    locationData: locationData ?? undefined,
  };
}
