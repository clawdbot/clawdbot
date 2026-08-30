// Telegram plugin module implements action runtime behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  resolvePollMaxSelections,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOutboundLocation } from "openclaw/plugin-sdk/channel-inbound";
import {
  buildOutboundSessionContext,
  sendDurableMessageBatch,
  type DurableMessageBatchSendResult,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import {
  createTelegramActionGate,
  resolveDefaultTelegramAccountId,
  resolveTelegramPollActionGateState,
} from "./accounts.js";
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "./approval-callback-data.js";
import {
  appendTelegramDroppedControlFallback,
  resolveTelegramInlineButtons,
  type TelegramButtonBuildOptions,
  type TelegramDroppedControl,
} from "./button-types.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";
import {
  resolveTelegramInlineButtonsScope,
  resolveTelegramTargetChatType,
} from "./inline-buttons.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";
import {
  resolveTelegramConversationReadChatId,
  resolveTelegramMessageMutationChatId,
  type TelegramMessageMutationContext,
} from "./message-topic-binding.js";
import { rejectTelegramNativeButtonParams } from "./native-button-params.js";
import { resolveTelegramPollVisibility } from "./poll-visibility.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
import {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  getTelegramAllowedReactions,
  pinMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
} from "./send.js";
import { TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST } from "./status-reaction-variants.js";
import { getCacheStats, searchStickers } from "./sticker-cache.js";
import { normalizeTelegramOutboundTarget, parseTelegramTarget } from "./targets.js";
import { resolveTelegramToken } from "./token.js";
import { resolveTopicNameCacheScope, updateTopicName } from "./topic-name-cache.js";

export const telegramActionRuntime = {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  getTelegramAllowedReactions,
  getCacheStats,
  pinMessageTelegram,
  reactMessageTelegram,
  searchStickers,
  sendDurableMessageBatch,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
};

const TELEGRAM_FORUM_TOPIC_ICON_COLORS = [
  0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f,
] as const;
const TELEGRAM_EMOJI_LIST_LIMIT = 100;
const TELEGRAM_REACTION_HINT_LIMIT = 20;
const TELEGRAM_ACTION_ALIASES = {
  createForumTopic: "createForumTopic",
  delete: "deleteMessage",
  deleteMessage: "deleteMessage",
  edit: "editMessage",
  editForumTopic: "editForumTopic",
  editMessage: "editMessage",
  "emoji-list": "emoji-list",
  poll: "poll",
  react: "react",
  searchSticker: "searchSticker",
  send: "sendMessage",
  sendMessage: "sendMessage",
  sendSticker: "sendSticker",
  sticker: "sendSticker",
  stickerCacheStats: "stickerCacheStats",
  "sticker-search": "searchSticker",
  "topic-create": "createForumTopic",
  "topic-edit": "editForumTopic",
} as const;

type TelegramActionName = (typeof TELEGRAM_ACTION_ALIASES)[keyof typeof TELEGRAM_ACTION_ALIASES];
type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;
type TelegramForumTopicIconColor = (typeof TELEGRAM_FORUM_TOPIC_ICON_COLORS)[number];

function readTelegramForumTopicIconColor(
  params: Record<string, unknown>,
): TelegramForumTopicIconColor | undefined {
  const iconColor = readPositiveIntegerParam(params, "iconColor", {
    message: "iconColor must be one of Telegram's supported forum topic colors.",
  });
  if (iconColor == null) {
    return undefined;
  }
  if (!TELEGRAM_FORUM_TOPIC_ICON_COLORS.includes(iconColor as TelegramForumTopicIconColor)) {
    throw new Error("iconColor must be one of Telegram's supported forum topic colors.");
  }
  return iconColor as TelegramForumTopicIconColor;
}
function normalizeTelegramActionName(action: string): TelegramActionName {
  const normalized = TELEGRAM_ACTION_ALIASES[action as keyof typeof TELEGRAM_ACTION_ALIASES];
  if (!normalized) {
    throw new Error(`Unsupported Telegram action: ${action}`);
  }
  return normalized;
}

function readTelegramChatId(params: Record<string, unknown>) {
  return (
    readStringOrNumberParam(params, "chatId") ??
    readStringOrNumberParam(params, "channelId") ??
    readStringOrNumberParam(params, "to", { required: true })
  );
}

function readTelegramThreadId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "messageThreadId", {
      message: "messageThreadId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "threadId", {
      message: "threadId must be a positive integer.",
    })
  );
}

function resolveActionTopicNameCacheScope(cfg: OpenClawConfig, accountId?: string | null): string {
  const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: resolvedAccountId }),
  });
  return resolveTopicNameCacheScope(storePath);
}

function formatTelegramDeliveryTarget(to: string, messageThreadId?: number | null): string {
  const parsed = parseTelegramTarget(to);
  const directTopicId = parsed.directMessagesTopicId;
  if (directTopicId != null) {
    return `${parsed.chatId}:direct-topic:${directTopicId}`;
  }
  const topicId = messageThreadId ?? parsed.messageThreadId;
  if (topicId == null) {
    return to;
  }
  return `${parsed.chatId}:topic:${topicId}`;
}

function readTelegramReplyToMessageId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "replyToMessageId", {
      message: "replyToMessageId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "replyTo", {
      message: "replyTo must be a positive integer.",
    })
  );
}

function pushTelegramMediaUrl(mediaUrls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  mediaUrls.push(normalized);
}

function readTelegramSendMediaUrls(params: Record<string, unknown>) {
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  pushTelegramMediaUrl(mediaUrls, seen, params.mediaUrl);
  pushTelegramMediaUrl(mediaUrls, seen, params.media);
  pushTelegramMediaUrl(mediaUrls, seen, params.path);
  pushTelegramMediaUrl(mediaUrls, seen, params.filePath);
  pushTelegramMediaUrl(mediaUrls, seen, params.fileUrl);
  if (Array.isArray(params.mediaUrls)) {
    for (const mediaUrl of params.mediaUrls) {
      pushTelegramMediaUrl(mediaUrls, seen, mediaUrl);
    }
  }
  if (Array.isArray(params.attachments)) {
    for (const attachment of params.attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        continue;
      }
      const record = attachment as Record<string, unknown>;
      pushTelegramMediaUrl(mediaUrls, seen, record.media);
      pushTelegramMediaUrl(mediaUrls, seen, record.mediaUrl);
      pushTelegramMediaUrl(mediaUrls, seen, record.path);
      pushTelegramMediaUrl(mediaUrls, seen, record.filePath);
      pushTelegramMediaUrl(mediaUrls, seen, record.fileUrl);
      pushTelegramMediaUrl(mediaUrls, seen, record.url);
    }
  }
  return mediaUrls;
}

function resolveTelegramButtonsFromParams(
  params: Record<string, unknown>,
  presentation = normalizeMessagePresentation(params.presentation),
  options?: TelegramButtonBuildOptions,
) {
  return resolveTelegramInlineButtons(
    {
      presentation,
      interactive: params.interactive,
    },
    options,
  );
}

function readTelegramSendContent(params: {
  args: Record<string, unknown>;
  mediaUrl?: string;
  hasButtons: boolean;
  hasLocation?: boolean;
  interactive?: unknown;
  presentation?: MessagePresentation;
}) {
  const explicitContent =
    readStringParam(params.args, "content", { allowEmpty: true }) ??
    readStringParam(params.args, "message", { allowEmpty: true }) ??
    readStringParam(params.args, "caption", { allowEmpty: true });
  const unsupportedBlocks =
    params.presentation?.blocks.filter(
      (block) => block.type === "chart" || block.type === "table",
    ) ?? [];
  const presentationText =
    explicitContent == null && params.presentation
      ? renderMessagePresentationFallbackText({ presentation: params.presentation })
      : explicitContent != null && unsupportedBlocks.length > 0
        ? renderMessagePresentationFallbackText({
            text: explicitContent,
            presentation: { ...params.presentation, blocks: unsupportedBlocks },
          })
        : undefined;
  const interactiveText =
    explicitContent == null && !params.presentation
      ? resolveTelegramInteractiveTextFallback({ interactive: params.interactive })
      : undefined;
  let content =
    (presentationText?.trim() ? presentationText : undefined) ??
    explicitContent ??
    (interactiveText?.trim() ? interactiveText : undefined);
  if ((content == null || content.trim().length === 0) && !params.mediaUrl && params.hasButtons) {
    const fallback = presentationText?.trim() ? presentationText : interactiveText;
    if (fallback?.trim()) {
      content = fallback;
    }
  }
  if (content == null && !params.mediaUrl && !params.hasButtons && !params.hasLocation) {
    throw new Error("content required.");
  }
  return {
    content: content ?? "",
    hasExplicitContent: explicitContent != null,
  };
}

function buildTelegramControlDegradation(
  controls: readonly TelegramDroppedControl[],
  fallbackDelivered: boolean,
) {
  if (controls.length === 0) {
    return undefined;
  }
  const reasons = [...new Set(controls.map((control) => control.reason))];
  const hasOverflow = reasons.includes("callback_data_too_long");
  return {
    warning: fallbackDelivered
      ? `Telegram delivered ${controls.length} unencodable control${controls.length === 1 ? "" : "s"} as readable text.`
      : `Telegram could not deliver ${controls.length} control${controls.length === 1 ? "" : "s"}.`,
    degradedDelivery: {
      droppedControls: controls.length,
      fallback: fallbackDelivered ? "text" : "not_delivered",
      reasons,
      ...(hasOverflow ? { callbackDataLimitBytes: TELEGRAM_CALLBACK_DATA_MAX_BYTES } : {}),
      guidance: hasOverflow
        ? `Shorten callback data to at most ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} UTF-8 bytes and retry if clickable controls are required.`
        : "Retry with a supported control action if clickable controls are required.",
    },
  };
}

function normalizeTelegramDeliveryPin(params: Record<string, unknown>) {
  const delivery = params.delivery;
  const pin =
    delivery && typeof delivery === "object" && !Array.isArray(delivery)
      ? (delivery as { pin?: unknown }).pin
      : params.pin === true
        ? true
        : undefined;
  if (pin === true) {
    return { enabled: true } as const;
  }
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
    return undefined;
  }
  const raw = pin as { enabled?: unknown; notify?: unknown; required?: unknown };
  if (raw.enabled !== true) {
    return undefined;
  }
  return {
    enabled: true,
    ...(raw.notify === true ? { notify: true } : {}),
    ...(raw.required === true ? { required: true } : {}),
  } as const;
}

function buildTelegramActionSendPayload(params: {
  content: string;
  mediaUrls: string[];
  asVoice?: boolean;
  asVideoNote?: boolean;
  location?: ReplyPayload["location"];
  pin?: ReturnType<typeof normalizeTelegramDeliveryPin>;
  buttons?: ReturnType<typeof resolveTelegramButtonsFromParams>;
  quoteText?: string;
}): ReplyPayload {
  const telegramData =
    params.buttons || params.quoteText
      ? {
          ...(params.buttons ? { buttons: params.buttons } : {}),
          ...(params.quoteText ? { quoteText: params.quoteText } : {}),
        }
      : undefined;
  return {
    text: params.content,
    ...(params.mediaUrls.length > 0 ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.asVoice === true ? { audioAsVoice: true } : {}),
    ...(params.asVideoNote === true ? { videoAsNote: true } : {}),
    ...(params.location ? { location: params.location } : {}),
    ...(params.pin ? { delivery: { pin: params.pin } } : {}),
    ...(telegramData ? { channelData: { telegram: telegramData } } : {}),
  };
}

function projectTelegramReceiptPlacement(
  receipt: MessageReceipt,
): { threadId?: string; replyToId?: string } | undefined {
  // Reconciliation only reads thread/reply placement from the delivered
  // receipt. Keep the model-visible tool result bounded: durable receipts
  // also carry unbounded multipart data and raw provider records (#133051).
  const placement = {
    ...(receipt.threadId ? { threadId: receipt.threadId } : {}),
    ...(receipt.replyToId ? { replyToId: receipt.replyToId } : {}),
  };
  return Object.keys(placement).length > 0 ? placement : undefined;
}

function getLastDurableTelegramActionResult(
  result: Extract<DurableMessageBatchSendResult, { status: "sent" }>,
): {
  messageId?: string;
  chatId?: string;
  receipt?: { threadId?: string; replyToId?: string };
} {
  const lastResult = result.results.at(-1);
  const receipt = result.receipt;
  return {
    messageId:
      lastResult?.messageId ??
      receipt.primaryPlatformMessageId ??
      receipt.platformMessageIds.at(-1),
    chatId: lastResult?.target?.kind === "chat" ? lastResult.target.id : undefined,
    // Preserve the durable receipt placement so source-reply reconciliation
    // can prove terminal delivery (including forum thread placement) instead
    // of failing closed and marking the completed session as aborted.
    receipt: projectTelegramReceiptPlacement(receipt),
  };
}

async function describeTelegramAllowedReactionSample(params: {
  chatId: string | number;
  cfg: OpenClawConfig;
  token: string;
  accountId?: string;
}): Promise<string> {
  const reactions = await telegramActionRuntime
    .getTelegramAllowedReactions(params.chatId, {
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    })
    .catch(() => null);
  const emojis = reactions
    ?.filter((reaction) => reaction.type === "emoji")
    .slice(0, TELEGRAM_REACTION_HINT_LIMIT)
    .map((reaction) => reaction.emoji);
  return emojis?.length ? ` This chat allows: ${emojis.join(" ")}.` : "";
}

export async function handleTelegramAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  options?: {
    mediaAccess?: ChannelMessageActionContext["mediaAccess"];
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    sessionKey?: string | null;
    inboundEventKind?: string;
    gatewayClientScopes?: readonly string[];
    deliveryRetryOwner?: ChannelMessageActionContext["deliveryRetryOwner"];
    conversationReadOrigin?: ConversationReadInvocationOrigin;
    requesterAccountId?: string | null;
    reply?: ChannelMessageActionContext["reply"];
    toolContext?: TelegramMessageMutationContext["toolContext"];
  },
): Promise<AgentToolResult<unknown>> {
  rejectTelegramNativeButtonParams(params);
  const { action, accountId } = {
    action: normalizeTelegramActionName(readStringParam(params, "action", { required: true })),
    accountId: readStringParam(params, "accountId"),
  };
  const isActionEnabled = createTelegramActionGate({
    cfg,
    accountId,
  });
  const notifyVisibleOutboundSuccess = (to: string, messageThreadId?: number | null) => {
    telegramInboundEventDelivery.notify({
      sessionKey: options?.sessionKey ?? undefined,
      to: formatTelegramDeliveryTarget(to, messageThreadId),
      accountId,
      inboundEventKind: options?.inboundEventKind,
    });
  };

  if (action === "emoji-list") {
    if (!isActionEnabled("reactions")) {
      throw new Error("Telegram reactions are disabled via actions.reactions.");
    }
    const chatId = resolveTelegramConversationReadChatId({
      chatId:
        readStringOrNumberParam(params, "chatId") ??
        readStringOrNumberParam(params, "channelId") ??
        readStringOrNumberParam(params, "to"),
      cfg,
      accountId,
      context: options,
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const limit = Math.min(
      readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      }) ?? TELEGRAM_EMOJI_LIST_LIMIT,
      TELEGRAM_EMOJI_LIST_LIMIT,
    );
    const allowed = await telegramActionRuntime.getTelegramAllowedReactions(chatId, {
      cfg,
      token,
      accountId: accountId ?? undefined,
    });
    const reactions =
      allowed ??
      TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST.map((emoji) => ({ type: "emoji" as const, emoji }));
    return jsonResult({
      ok: true,
      emojis: reactions
        .slice(0, limit)
        .map((reaction) =>
          reaction.type === "emoji"
            ? { name: reaction.emoji, identifier: reaction.emoji }
            : { identifier: reaction.custom_emoji_id, type: "custom_emoji" },
        ),
      ...(allowed === null ? { note: "All standard Telegram reactions are allowed." } : {}),
    });
  }

  if (action === "react") {
    // All react failures return soft results (jsonResult with ok:false) instead
    // of throwing, because hard tool errors can trigger model re-generation
    // loops and duplicate content.
    const reactionLevelInfo = resolveTelegramReactionLevel({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (!reactionLevelInfo.agentReactionsEnabled) {
      return jsonResult({
        ok: false,
        reason: "disabled",
        hint: `Telegram agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). Do not retry.`,
      });
    }
    if (!isActionEnabled("reactions")) {
      return jsonResult({
        ok: false,
        reason: "disabled",
        hint: "Telegram reactions are disabled via actions.reactions. Do not retry.",
      });
    }
    const chatId = readTelegramChatId(params);
    let explicitMessageId: number | undefined;
    try {
      explicitMessageId = readPositiveIntegerParam(params, "messageId", {
        message: "messageId must be a positive integer.",
      });
    } catch {
      return jsonResult({
        ok: false,
        reason: "missing_message_id",
        hint: "Telegram reaction requires a valid messageId (or inbound context fallback). Do not retry.",
      });
    }
    const messageId = explicitMessageId ?? resolveReactionMessageId({ args: params });
    if (typeof messageId !== "number" || !Number.isFinite(messageId) || messageId <= 0) {
      return jsonResult({
        ok: false,
        reason: "missing_message_id",
        hint: "Telegram reaction requires a valid messageId (or inbound context fallback). Do not retry.",
      });
    }
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a Telegram reaction.",
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      return jsonResult({
        ok: false,
        reason: "missing_token",
        hint: "Telegram bot token missing. Do not retry.",
      });
    }
    let reactionResult: Awaited<ReturnType<typeof telegramActionRuntime.reactMessageTelegram>>;
    let authorizedChatId: string | number = chatId ?? "";
    try {
      authorizedChatId = await resolveTelegramMessageMutationChatId({
        chatId: chatId ?? "",
        messageId,
        cfg,
        accountId,
        context: options,
      });
      reactionResult = await telegramActionRuntime.reactMessageTelegram(
        authorizedChatId,
        messageId ?? 0,
        emoji ?? "",
        {
          cfg,
          token,
          remove,
          accountId: accountId ?? undefined,
          gatewayClientScopes: options?.gatewayClientScopes,
        },
      );
    } catch (err) {
      const isInvalid = String(err).includes("REACTION_INVALID");
      return jsonResult({
        ok: false,
        reason: isInvalid ? "REACTION_INVALID" : "error",
        emoji,
        hint: isInvalid
          ? `This reaction is unavailable.${await describeTelegramAllowedReactionSample({
              chatId: authorizedChatId,
              cfg,
              token,
              accountId: accountId ?? undefined,
            })}`
          : "Reaction failed. Do not retry.",
      });
    }
    if (!reactionResult.ok) {
      const allowedHint = await describeTelegramAllowedReactionSample({
        chatId: authorizedChatId,
        cfg,
        token,
        accountId: accountId ?? undefined,
      });
      return jsonResult({
        ok: false,
        warning: `${reactionResult.warning}${allowedHint}`,
        ...(remove || isEmpty ? { removed: true } : { added: emoji }),
      });
    }
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "sendMessage") {
    if (!isActionEnabled("sendMessage")) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    const to = normalizeTelegramOutboundTarget(readStringParam(params, "to", { required: true }));
    const mediaUrls = readTelegramSendMediaUrls(params);
    const firstMediaUrl = mediaUrls[0];
    const location = normalizeOutboundLocation(params.location);
    const presentation = normalizeMessagePresentation(params.presentation);
    const droppedControls: TelegramDroppedControl[] = [];
    const buttons = resolveTelegramButtonsFromParams(params, presentation, {
      allowWebAppButtons: resolveTelegramTargetChatType(to) === "direct",
      onDroppedControl: (control) => droppedControls.push(control),
    });
    const resolvedContent = readTelegramSendContent({
      args: params,
      mediaUrl: firstMediaUrl,
      hasButtons: Array.isArray(buttons) && buttons.length > 0,
      hasLocation: Boolean(location),
      interactive: params.interactive,
      presentation,
    });
    const content =
      droppedControls.length > 0 && resolvedContent.hasExplicitContent
        ? appendTelegramDroppedControlFallback(resolvedContent.content, droppedControls)
        : resolvedContent.content;
    const droppedControlFallback = appendTelegramDroppedControlFallback("", droppedControls);
    const hasOnlyDroppedControlFallback =
      !resolvedContent.hasExplicitContent &&
      droppedControlFallback.length > 0 &&
      content.trim() === droppedControlFallback.trim();
    const asVideoNote = readBooleanParam(params, "asVideoNote") ?? false;
    if (
      location &&
      ((content.trim() && !hasOnlyDroppedControlFallback) || mediaUrls.length > 0 || asVideoNote)
    ) {
      throw new Error("Telegram location sends cannot be combined with message text or media.");
    }
    if (asVideoNote && mediaUrls.length !== 1) {
      throw new Error("Telegram video notes require exactly one media attachment.");
    }
    if (buttons) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId: accountId ?? undefined,
      });
      if (inlineButtonsScope === "off") {
        throw new Error(
          'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
        );
      }
      if (inlineButtonsScope === "dm" || inlineButtonsScope === "group") {
        const targetType = resolveTelegramTargetChatType(to);
        if (targetType === "unknown") {
          throw new Error(
            `Telegram inline buttons require a numeric chat id when inlineButtons="${inlineButtonsScope}".`,
          );
        }
        if (inlineButtonsScope === "dm" && targetType !== "direct") {
          throw new Error('Telegram inline buttons are limited to DMs when inlineButtons="dm".');
        }
        if (inlineButtonsScope === "group" && targetType !== "group") {
          throw new Error(
            'Telegram inline buttons are limited to groups when inlineButtons="group".',
          );
        }
      }
    }
    // Optional threading parameters for forum topics and reply chains
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const quoteText = readStringParam(params, "quoteText", { trim: false });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const sendOptions = {
      cfg,
      accountId: accountId ?? undefined,
      gatewayClientScopes: options?.gatewayClientScopes,
      replyToMessageId: replyToMessageId ?? undefined,
      messageThreadId: messageThreadId ?? undefined,
      quoteText: quoteText ?? undefined,
      asVoice: readBooleanParam(params, "asVoice"),
      asVideoNote,
      silent: readBooleanParam(params, "silent"),
      forceDocument:
        readBooleanParam(params, "forceDocument") ??
        readBooleanParam(params, "asDocument") ??
        false,
    };
    const payload = buildTelegramActionSendPayload({
      content,
      mediaUrls,
      asVoice: sendOptions.asVoice,
      asVideoNote: sendOptions.asVideoNote,
      location,
      pin: normalizeTelegramDeliveryPin(params),
      buttons,
      quoteText,
    });
    const mediaAccess =
      options?.mediaAccess ??
      (options?.mediaLocalRoots || options?.mediaReadFile
        ? {
            ...(options.mediaLocalRoots ? { localRoots: options.mediaLocalRoots } : {}),
            ...(options.mediaReadFile ? { readFile: options.mediaReadFile } : {}),
          }
        : undefined);
    const outboundSession = buildOutboundSessionContext({
      cfg,
      sessionKey: options?.sessionKey,
      requesterAccountId: accountId,
    });
    const durableResult = await telegramActionRuntime.sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to,
      accountId: accountId ?? undefined,
      payloads: [payload],
      ...(options?.reply
        ? { reply: options.reply }
        : { replyToId: replyToMessageId == null ? undefined : String(replyToMessageId) }),
      threadId: messageThreadId,
      forceDocument: sendOptions.forceDocument,
      silent: sendOptions.silent,
      durability: "required",
      gatewayClientScopes: options?.gatewayClientScopes,
      deliveryRetryOwner: options?.deliveryRetryOwner,
      ...(mediaAccess ? { mediaAccess } : {}),
      ...(outboundSession ? { session: outboundSession } : {}),
    });
    if (durableResult.status === "failed" || durableResult.status === "partial_failed") {
      throw durableResult.error;
    }
    if (durableResult.status === "suppressed") {
      throw new Error("Telegram sendMessage was suppressed before delivery.");
    }
    const result = getLastDurableTelegramActionResult(durableResult);
    notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      ...(result.receipt ? { receipt: result.receipt } : {}),
      ...buildTelegramControlDegradation(droppedControls, Boolean(content.trim())),
    });
  }

  if (action === "poll") {
    const pollActionState = resolveTelegramPollActionGateState(isActionEnabled);
    if (!pollActionState.sendMessageEnabled) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    if (!pollActionState.pollEnabled) {
      throw new Error("Telegram polls are disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const question =
      readStringParam(params, "question") ??
      readStringParam(params, "pollQuestion", { required: true });
    const answers =
      readStringArrayParam(params, "answers") ??
      readStringArrayParam(params, "pollOption", { required: true });
    const allowMultiselect =
      readBooleanParam(params, "allowMultiselect") ?? readBooleanParam(params, "pollMulti");
    const durationSeconds =
      readPositiveIntegerParam(params, "durationSeconds", {
        message: "durationSeconds must be a positive integer.",
      }) ??
      readPositiveIntegerParam(params, "pollDurationSeconds", {
        message: "pollDurationSeconds must be a positive integer.",
      });
    const durationHours =
      readPositiveIntegerParam(params, "durationHours", {
        message: "durationHours must be a positive integer.",
      }) ??
      readPositiveIntegerParam(params, "pollDurationHours", {
        message: "pollDurationHours must be a positive integer.",
      });
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const isAnonymous =
      readBooleanParam(params, "isAnonymous") ??
      resolveTelegramPollVisibility({
        pollAnonymous: readBooleanParam(params, "pollAnonymous"),
        pollPublic: readBooleanParam(params, "pollPublic"),
      });
    const silent = readBooleanParam(params, "silent");
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.sendPollTelegram(
      to,
      {
        question,
        options: answers,
        maxSelections: resolvePollMaxSelections(answers.length, allowMultiselect ?? false),
        durationSeconds: durationSeconds ?? undefined,
        durationHours: durationHours ?? undefined,
      },
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        replyToMessageId: replyToMessageId ?? undefined,
        messageThreadId: messageThreadId ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
        silent: silent ?? undefined,
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      pollId: result.pollId,
      ...(result.pollAnswerRouting ? { pollAnswerRouting: result.pollAnswerRouting } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    });
  }

  if (action === "deleteMessage") {
    if (!isActionEnabled("deleteMessage")) {
      throw new Error("Telegram deleteMessage is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageId = readPositiveIntegerParam(params, "messageId", {
      message: "messageId must be a positive integer.",
    });
    if (messageId === undefined) {
      throw new Error("messageId required");
    }
    const authorizedChatId = await resolveTelegramMessageMutationChatId({
      chatId: chatId ?? "",
      messageId,
      cfg,
      accountId,
      context: options,
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.deleteMessageTelegram(
      authorizedChatId,
      messageId ?? 0,
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    if (!result.ok) {
      return jsonResult({ ok: false, deleted: false, warning: result.warning });
    }
    return jsonResult({ ok: true, deleted: true });
  }

  if (action === "editMessage") {
    if (!isActionEnabled("editMessage")) {
      throw new Error("Telegram editMessage is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageId = readPositiveIntegerParam(params, "messageId", {
      message: "messageId must be a positive integer.",
    });
    if (messageId === undefined) {
      throw new Error("messageId required");
    }
    const authorizedChatId = await resolveTelegramMessageMutationChatId({
      chatId: chatId ?? "",
      messageId,
      cfg,
      accountId,
      context: options,
    });
    let content =
      readStringParam(params, "content", { allowEmpty: false }) ??
      readStringParam(params, "message", { allowEmpty: false });
    // Telegram treats an explicit empty caption as a request to remove it.
    let caption = readStringParam(params, "caption", { allowEmpty: true });
    const droppedControls: TelegramDroppedControl[] = [];
    const buttons = resolveTelegramButtonsFromParams(params, undefined, {
      allowWebAppButtons: resolveTelegramTargetChatType(chatId ?? "") === "direct",
      onDroppedControl: (control) => droppedControls.push(control),
    });
    if (droppedControls.length > 0) {
      if (caption != null) {
        caption = appendTelegramDroppedControlFallback(caption, droppedControls);
      } else if (content != null) {
        content = appendTelegramDroppedControlFallback(content, droppedControls);
      }
    }
    if (content == null && caption == null && buttons === undefined) {
      const degradation = buildTelegramControlDegradation(droppedControls, false);
      if (degradation) {
        return jsonResult({ ok: false, ...degradation });
      }
      throw new Error("content required.");
    }
    if (buttons !== undefined) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId: accountId ?? undefined,
      });
      if (inlineButtonsScope === "off") {
        throw new Error(
          'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
        );
      }
    }
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    if (content == null && caption == null && buttons !== undefined) {
      const result = await telegramActionRuntime.editMessageReplyMarkupTelegram(
        authorizedChatId,
        messageId ?? 0,
        buttons,
        {
          cfg,
          token,
          accountId: accountId ?? undefined,
          gatewayClientScopes: options?.gatewayClientScopes,
        },
      );
      return jsonResult({
        ok: true,
        messageId: result.messageId,
        chatId: result.chatId,
        ...buildTelegramControlDegradation(droppedControls, false),
      });
    }
    const result = await telegramActionRuntime.editMessageTelegram(
      authorizedChatId,
      messageId ?? 0,
      caption ?? content ?? "",
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        buttons,
        editMode: caption != null ? "caption" : "auto",
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      ...buildTelegramControlDegradation(droppedControls, true),
    });
  }

  if (action === "sendSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const to =
      readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
    const fileId =
      readStringParam(params, "fileId") ?? readStringArrayParam(params, "stickerId")?.[0];
    if (!fileId) {
      throw new Error("fileId is required.");
    }
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.sendStickerTelegram(to, fileId, {
      cfg,
      token,
      accountId: accountId ?? undefined,
      replyToMessageId: replyToMessageId ?? undefined,
      messageThreadId: messageThreadId ?? undefined,
      gatewayClientScopes: options?.gatewayClientScopes,
    });
    notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  }

  if (action === "searchSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const query = readStringParam(params, "query", { required: true });
    const limit =
      readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      }) ?? 5;
    const results = telegramActionRuntime.searchStickers(query, limit);
    return jsonResult({
      ok: true,
      count: results.length,
      stickers: results.map((s) => ({
        fileId: s.fileId,
        emoji: s.emoji,
        description: s.description,
        setName: s.setName,
      })),
    });
  }

  if (action === "stickerCacheStats") {
    const stats = telegramActionRuntime.getCacheStats();
    return jsonResult({ ok: true, ...stats });
  }

  if (action === "createForumTopic") {
    if (!isActionEnabled("createForumTopic")) {
      throw new Error("Telegram createForumTopic is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const name =
      readStringParam(params, "name") ??
      readStringParam(params, "threadName", { required: true, label: "name" });
    const iconColor = readTelegramForumTopicIconColor(params);
    const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.createForumTopicTelegram(chatId ?? "", name, {
      cfg,
      token,
      accountId: accountId ?? undefined,
      iconColor,
      iconCustomEmojiId: iconCustomEmojiId ?? undefined,
      gatewayClientScopes: options?.gatewayClientScopes,
    });
    if (result.topicId != null && result.chatId) {
      await updateTopicName(
        result.chatId,
        result.topicId,
        {
          name,
          ...(iconColor != null ? { iconColor } : {}),
          ...(iconCustomEmojiId ? { iconCustomEmojiId } : {}),
        },
        resolveActionTopicNameCacheScope(cfg, accountId),
      ).catch(() => {});
    }
    return jsonResult({
      ok: true,
      topicId: result.topicId,
      name: result.name,
      chatId: result.chatId,
    });
  }

  if (action === "editForumTopic") {
    if (!isActionEnabled("editForumTopic")) {
      throw new Error("Telegram editForumTopic is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageThreadId = readTelegramThreadId(params);
    if (typeof messageThreadId !== "number") {
      throw new Error("messageThreadId or threadId is required.");
    }
    const name = readStringParam(params, "name") ?? readStringParam(params, "threadName");
    const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.editForumTopicTelegram(
      chatId ?? "",
      messageThreadId,
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        name: name ?? undefined,
        iconCustomEmojiId: iconCustomEmojiId ?? undefined,
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    if (result.chatId) {
      const patch: { name?: string; iconCustomEmojiId?: string } = {};
      if (name) {
        patch.name = name;
      }
      if (iconCustomEmojiId) {
        patch.iconCustomEmojiId = iconCustomEmojiId;
      }
      if (Object.keys(patch).length > 0) {
        await updateTopicName(
          result.chatId,
          result.messageThreadId,
          patch,
          resolveActionTopicNameCacheScope(cfg, accountId),
        ).catch(() => {});
      }
    }
    return jsonResult(result);
  }

  throw new Error(`Unsupported Telegram action: ${String(action)}`);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
