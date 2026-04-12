import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
  toLocationContext,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { normalizeCommandBody } from "openclaw/plugin-sdk/command-surface";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/config-runtime";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import {
  buildPendingHistoryContextFromMap,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import type {
  TelegramMediaRef,
  TelegramMessageContextOptions,
  TelegramMessageContextSessionRuntimeOverrides,
} from "./bot-message-context.types.js";
import {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  describeReplyTarget,
  normalizeForwardedContext,
  type TelegramReplyTarget,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";

type FinalizedTelegramInboundContext = ReturnType<
  typeof import("./bot-message-context.session.runtime.js").finalizeInboundContext
>;

type TelegramMessageContextSessionRuntime =
  typeof import("./bot-message-context.session.runtime.js");

const sessionRuntimeMethods = [
  "finalizeInboundContext",
  "readSessionUpdatedAt",
  "recordInboundSession",
  "resolveInboundLastRouteSessionKey",
  "resolvePinnedMainDmOwnerFromAllowlist",
  "resolveStorePath",
] as const satisfies readonly (keyof TelegramMessageContextSessionRuntime)[];

function hasCompleteSessionRuntime(
  runtime: TelegramMessageContextSessionRuntimeOverrides | undefined,
): runtime is TelegramMessageContextSessionRuntime {
  return Boolean(
    runtime && sessionRuntimeMethods.every((method) => typeof runtime[method] === "function"),
  );
}

async function loadTelegramMessageContextSessionRuntime(
  runtime: TelegramMessageContextSessionRuntimeOverrides | undefined,
): Promise<TelegramMessageContextSessionRuntime> {
  if (hasCompleteSessionRuntime(runtime)) {
    return runtime;
  }
  return {
    ...(await import("./bot-message-context.session.runtime.js")),
    ...runtime,
  };
}

export async function buildTelegramInboundContextPayload(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  replyMedia: TelegramMediaRef[];
  isGroup: boolean;
  isForum: boolean;
  chatId: number | string;
  senderId: string;
  senderUsername: string;
  resolvedThreadId?: number;
  dmThreadId?: number;
  threadSpec: TelegramThreadSpec;
  route: ResolvedAgentRoute;
  rawBody: string;
  bodyText: string;
  historyKey?: string;
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  stickerCacheHit: boolean;
  effectiveWasMentioned: boolean;
  commandAuthorized: boolean;
  locationData?: NormalizedLocation;
  options?: TelegramMessageContextOptions;
  dmAllowFrom?: Array<string | number>;
  effectiveGroupAllow?: NormalizedAllowFrom;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
}): Promise<{
  ctxPayload: FinalizedTelegramInboundContext;
  skillFilter: string[] | undefined;
}> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    replyMedia,
    isGroup,
    isForum,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    dmThreadId,
    threadSpec,
    route,
    rawBody,
    bodyText,
    historyKey,
    historyLimit,
    groupHistories,
    groupConfig,
    topicConfig,
    stickerCacheHit,
    effectiveWasMentioned,
    commandAuthorized,
    locationData,
    options,
    dmAllowFrom,
    effectiveGroupAllow,
    sessionRuntime: sessionRuntimeOverride,
  } = params;
  const replyTarget = describeReplyTarget(msg);
  const forwardOrigin = normalizeForwardedContext(msg);
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const shouldIncludeGroupSupplementalContext = (params: {
    kind: "quote" | "forwarded";
    senderId?: string;
    senderUsername?: string;
  }): boolean => {
    if (!isGroup) {
      return true;
    }
    const senderAllowed = effectiveGroupAllow?.hasEntries
      ? isSenderAllowed({
          allow: effectiveGroupAllow,
          senderId: params.senderId,
          senderUsername: params.senderUsername,
        })
      : true;
    return evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: params.kind,
      senderAllowed,
    }).include;
  };
  const includeReplyTarget = replyTarget
    ? shouldIncludeGroupSupplementalContext({
        kind: "quote",
        senderId: replyTarget.senderId,
        senderUsername: replyTarget.senderUsername,
      })
    : false;
  const includeForwardOrigin = forwardOrigin
    ? shouldIncludeGroupSupplementalContext({
        kind: "forwarded",
        senderId: forwardOrigin.fromId,
        senderUsername: forwardOrigin.fromUsername,
      })
    : false;
  const visibleReplyForwardedFrom =
    includeReplyTarget && replyTarget?.forwardedFrom
      ? shouldIncludeGroupSupplementalContext({
          kind: "forwarded",
          senderId: replyTarget.forwardedFrom.fromId,
          senderUsername: replyTarget.forwardedFrom.fromUsername,
        })
        ? replyTarget.forwardedFrom
        : undefined
      : undefined;
  const visibleReplyTarget: TelegramReplyTarget | null =
    includeReplyTarget && replyTarget
      ? {
          ...replyTarget,
          forwardedFrom: visibleReplyForwardedFrom,
        }
      : null;
  const visibleForwardOrigin = includeForwardOrigin ? forwardOrigin : null;
  const replyForwardAnnotation = visibleReplyTarget?.forwardedFrom
    ? `[Forwarded from ${visibleReplyTarget.forwardedFrom.from}${
        visibleReplyTarget.forwardedFrom.date
          ? ` at ${new Date(visibleReplyTarget.forwardedFrom.date * 1000).toISOString()}`
          : ""
      }]\n`
    : "";
  const replySuffix = visibleReplyTarget
    ? visibleReplyTarget.kind === "quote"
      ? `\n\n[Quoting ${visibleReplyTarget.sender}${
          visibleReplyTarget.id ? ` id:${visibleReplyTarget.id}` : ""
        }]\n${replyForwardAnnotation}"${visibleReplyTarget.body}"\n[/Quoting]`
      : `\n\n[Replying to ${visibleReplyTarget.sender}${
          visibleReplyTarget.id ? ` id:${visibleReplyTarget.id}` : ""
        }]\n${replyForwardAnnotation}${visibleReplyTarget.body}\n[/Replying]`
    : "";
  const forwardPrefix = visibleForwardOrigin
    ? `[Forwarded from ${visibleForwardOrigin.from}${
        visibleForwardOrigin.date
          ? ` at ${new Date(visibleForwardOrigin.date * 1000).toISOString()}`
          : ""
      }]\n`
    : "";
  const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : undefined;
  const senderName = buildSenderName(msg);
  const conversationLabel = isGroup
    ? (groupLabel ?? `group:${chatId}`)
    : buildSenderLabel(msg, senderId || chatId);
  const sessionRuntime = await loadTelegramMessageContextSessionRuntime(sessionRuntimeOverride);
  const storePath = sessionRuntime.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = sessionRuntime.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Telegram",
    from: conversationLabel,
    timestamp: msg.date ? msg.date * 1000 : undefined,
    body: `${forwardPrefix}${bodyText}${replySuffix}`,
    chatType: isGroup ? "group" : "direct",
    sender: {
      name: senderName,
      username: senderUsername || undefined,
      id: senderId || undefined,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let combinedBody = body;
  if (isGroup && historyKey && historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Telegram",
          from: groupLabel ?? `group:${chatId}`,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig,
    topicConfig,
  });
  const commandBody = normalizeCommandBody(rawBody, {
    botUsername: normalizeOptionalLowercaseString(primaryCtx.me?.username),
  });
  const inboundHistory =
    isGroup && historyKey && historyLimit > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const currentMediaForContext = stickerCacheHit ? [] : allMedia;
  const contextMedia = [...currentMediaForContext, ...replyMedia];
  const ctxPayload = sessionRuntime.finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: bodyText,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
    To: `telegram:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
    GroupSystemPrompt: isGroup || (!isGroup && groupConfig) ? groupSystemPrompt : undefined,
    SenderName: senderName,
    SenderId: senderId || undefined,
    SenderUsername: senderUsername || undefined,
    Provider: "telegram",
    Surface: "telegram",
    BotUsername: primaryCtx.me?.username ?? undefined,
    MessageSid: options?.messageIdOverride ?? String(msg.message_id),
    ReplyToId: visibleReplyTarget?.id,
    ReplyToBody: visibleReplyTarget?.body,
    ReplyToSender: visibleReplyTarget?.sender,
    ReplyToIsQuote: visibleReplyTarget?.kind === "quote" ? true : undefined,
    ReplyToForwardedFrom: visibleReplyTarget?.forwardedFrom?.from,
    ReplyToForwardedFromType: visibleReplyTarget?.forwardedFrom?.fromType,
    ReplyToForwardedFromId: visibleReplyTarget?.forwardedFrom?.fromId,
    ReplyToForwardedFromUsername: visibleReplyTarget?.forwardedFrom?.fromUsername,
    ReplyToForwardedFromTitle: visibleReplyTarget?.forwardedFrom?.fromTitle,
    ReplyToForwardedDate: visibleReplyTarget?.forwardedFrom?.date
      ? visibleReplyTarget.forwardedFrom.date * 1000
      : undefined,
    ForwardedFrom: visibleForwardOrigin?.from,
    ForwardedFromType: visibleForwardOrigin?.fromType,
    ForwardedFromId: visibleForwardOrigin?.fromId,
    ForwardedFromUsername: visibleForwardOrigin?.fromUsername,
    ForwardedFromTitle: visibleForwardOrigin?.fromTitle,
    ForwardedFromSignature: visibleForwardOrigin?.fromSignature,
    ForwardedFromChatType: visibleForwardOrigin?.fromChatType,
    ForwardedFromMessageId: visibleForwardOrigin?.fromMessageId,
    ForwardedDate: visibleForwardOrigin?.date ? visibleForwardOrigin.date * 1000 : undefined,
    Timestamp: msg.date ? msg.date * 1000 : undefined,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    MediaPath: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaType: contextMedia.length > 0 ? contextMedia[0]?.contentType : undefined,
    MediaUrl: contextMedia.length > 0 ? contextMedia[0]?.path : undefined,
    MediaPaths: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaUrls: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : undefined,
    MediaTypes:
      contextMedia.length > 0
        ? (contextMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    Sticker: allMedia[0]?.stickerMetadata,
    StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : undefined,
    ...(locationData ? toLocationContext(locationData) : undefined),
    CommandAuthorized: commandAuthorized,
    CommandSource: options?.commandSource,
    MessageThreadId: threadSpec.id,
    IsForum: isForum,
    OriginatingChannel: "telegram" as const,
    OriginatingTo: `telegram:${chatId}`,
  });

  const pinnedMainDmOwner = !isGroup
    ? sessionRuntime.resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: dmAllowFrom,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;
  const updateLastRouteSessionKey = sessionRuntime.resolveInboundLastRouteSessionKey({
    route,
    sessionKey: route.sessionKey,
  });
  const shouldPersistGroupLastRouteThread = isGroup && route.matchedBy !== "binding.channel";
  const updateLastRouteThreadId = isGroup
    ? shouldPersistGroupLastRouteThread && resolvedThreadId != null
      ? String(resolvedThreadId)
      : undefined
    : dmThreadId != null
      ? String(dmThreadId)
      : undefined;

  await sessionRuntime.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute:
      !isGroup || updateLastRouteThreadId != null
        ? {
            sessionKey: updateLastRouteSessionKey,
            channel: "telegram",
            to:
              isGroup && updateLastRouteThreadId != null
                ? `telegram:${chatId}:topic:${updateLastRouteThreadId}`
                : `telegram:${chatId}`,
            accountId: route.accountId,
            threadId: updateLastRouteThreadId,
            mainDmOwnerPin:
              !isGroup &&
              updateLastRouteSessionKey === route.mainSessionKey &&
              pinnedMainDmOwner &&
              senderId
                ? {
                    ownerRecipient: pinnedMainDmOwner,
                    senderRecipient: senderId,
                    onSkip: ({ ownerRecipient, senderRecipient }) => {
                      logVerbose(
                        `telegram: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                      );
                    },
                  }
                : undefined,
          }
        : undefined,
    onRecordError: (err) => {
      logVerbose(`telegram: failed updating session meta: ${String(err)}`);
    },
  });

  if (visibleReplyTarget && shouldLogVerbose()) {
    const preview = visibleReplyTarget.body.replace(/\s+/g, " ").slice(0, 120);
    logVerbose(
      `telegram reply-context: replyToId=${visibleReplyTarget.id} replyToSender=${visibleReplyTarget.sender} replyToBody="${preview}"`,
    );
  }

  if (visibleForwardOrigin && shouldLogVerbose()) {
    logVerbose(
      `telegram forward-context: forwardedFrom="${visibleForwardOrigin.from}" type=${visibleForwardOrigin.fromType}`,
    );
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
    logVerbose(
      `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    skillFilter,
  };
}
